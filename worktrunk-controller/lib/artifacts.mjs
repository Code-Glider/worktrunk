import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { digest, integer } from './data.mjs';
import { fileIdentity, localPath, overlap, within } from './paths.mjs';
import { inactive } from './admission.mjs';
import { inventoryContents } from './observe.mjs';
import { decideArtifact } from './policy.mjs';
import { verifyNativeHost } from './native-host.mjs';

function configured(config, id) {
  const artifact = config.artifactRoots.find(root => root.id === id);
  if (!artifact) throw new Error('Unknown configured artifact root');
  return artifact;
}

function binding(artifact) {
  return digest({ id: artifact.id, path: artifact.path, owner: artifact.owner, projects: artifact.projects });
}

function identity(store, artifact, root = artifact.path) {
  const record = store.get('artifact_identity', artifact.id)?.value;
  return record?.binding === binding(artifact) && digest(record.incarnation) === digest(fileIdentity(root)) ? record : null;
}

export function enrollArtifact(config, store, artifactId, now = Date.now()) {
  integer(now, 'enrollment time', 1);
  const artifact = configured(config, artifactId), root = localPath(artifact.path);
  if (!fs.statSync(root).isDirectory()) throw new Error('Artifact root must be a directory');
  if (artifact.owner !== config.host.id) throw new Error('Artifact owner does not match this host');
  const incarnation = fileIdentity(root);
  return store.transaction(tx => {
    if (tx.get('artifact_identity', artifact.id)) throw new Error('Artifact already enrolled; explicit repair required');
    if (digest(incarnation) !== digest(fileIdentity(root))) throw new Error('Artifact incarnation changed before enrollment');
    const record = { version: 1, id: randomUUID(), artifactId, binding: binding(artifact), incarnation, enrolledAt: now };
    tx.put('artifact_identity', artifactId, record);
    return { ...record, path: root };
  });
}

function classification(artifact, relative) {
  const parts = (relative === '.' ? artifact.path : relative).split(/[/\\]/).map(part => part.toLowerCase());
  if (parts.some(part => ['.ssh', '.aws', '.gnupg', '.npmrc', '.netrc', 'credentials', 'id_rsa', 'id_ed25519'].includes(part) || part === '.env' || part.startsWith('.env.') || /\.(pem|key)$/.test(part))) return 'credentials';
  if (parts.some(part => ['.git', '.archon', '.sandcastle'].includes(part))) return 'configuration';
  const key = relative.replaceAll(path.sep, '/');
  const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const matches = artifact.classes.filter(rule => rule.path === '.' || fold(key) === fold(rule.path) || fold(key).startsWith(`${fold(rule.path)}/`));
  // A narrower cache rule cannot override a protected ancestor's disposition.
  return matches.find(rule => rule.kind !== 'reproducible_cache')?.kind ?? matches[0]?.kind ?? 'unknown';
}

export function inspectArtifact(config, store, artifactId, now = Date.now(), ownCleanupToken) {
  const artifact = configured(config, artifactId);
  const target = { kind: 'artifact', artifactId, path: artifact.path, projects: artifact.projects };
  let decision;
  try {
    const claim = ownCleanupToken && store.get('claim', ownCleanupToken)?.value;
    const action = claim?.actionId && store.get('action', claim.actionId)?.value;
    if (claim?.roots[0]?.currentPath && (!action || action.artifactId !== artifactId || action.owner !== config.host.id || action.domain !== process.platform || action.originalPath !== artifact.path || !/^[a-f0-9-]{36}$/.test(action.id) || claim.roots[0].currentPath !== path.join(config.quarantineDir, action.id, 'payload'))) throw new Error('Artifact cleanup relocation does not match configuration');
    const root = localPath(claim?.roots[0]?.currentPath ?? artifact.path);
    if (!fs.statSync(root).isDirectory()) throw new Error('Artifact root must be a directory');
    const before = fileIdentity(root), enrolled = identity(store, artifact, root);
    const classes = { reproducible_cache: 0, configuration: 0, credentials: 0, evidence: 0, unknown: 0 };
    classes[classification(artifact, '.')]++;
    const contents = inventoryContents(root, config.limits, { skipGit: false, visitEntry(relative) { classes[classification(artifact, relative)]++; } });
    if (digest(before) !== digest(fileIdentity(root))) throw new Error('Artifact incarnation changed during inventory');
    const nativeHost = artifact.producerAdmission === 'cooperative-windows-job-v1' && process.platform === 'win32' && config.nativeHost ? verifyNativeHost(config) : null;
    const evidence = {
      identity: enrolled?.id ?? null, incarnation: before, enrolledAt: enrolled?.enrolledAt ?? null,
      ownerMatches: artifact.owner === config.host.id, managedOnly: artifact.managedOnly,
      admissionContract: artifact.producerAdmission ?? null, nativeHost,
      producerAdmission: nativeHost !== null, inactiveProducers: inactive(store, root, ownCleanupToken),
      protectedPath: [config.stateDir, config.quarantineDir, fileURLToPath(new URL('../', import.meta.url))].some(protectedRoot => overlap(artifact.path, protectedRoot)) || within(artifact.path, process.cwd()),
      classes, contents, links: contents.links, nested: contents.nested,
    };
    decision = { ...target, ...decideArtifact(evidence, config.policy, now), evidence };
  } catch (error) { decision = { ...target, status: 'analysis_failed', reasons: ['artifact_observation_unavailable'], evidence: null, error: error.message }; }
  return { ...decision, id: digest({ policy: config.generation, ...decision }) };
}

export function producerRoots(config, store, projectId, worktreeRoot) {
  const artifacts = config.artifactRoots ?? [];
  if (artifacts.length && !projectId) throw new Error('Artifact admission requires an explicit project');
  const roots = [localPath(worktreeRoot)];
  for (const artifact of artifacts.filter(root => root.projects.includes(projectId))) {
    if (!artifact.managedOnly || artifact.owner !== config.host.id || !identity(store, artifact)) throw new Error('Managed artifact admission requires matching ownership and enrollment');
    roots.push(localPath(artifact.path));
  }
  return [...new Set(roots)];
}
