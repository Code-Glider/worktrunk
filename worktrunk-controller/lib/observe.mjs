import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { digest, object, text } from './data.mjs';
import { fileIdentity, localPath, overlap } from './paths.mjs';
import { invocation, refVector, worktreeInventory } from './invoke.mjs';
import { inspectIdentity } from './identity.mjs';
import { decideWorktree } from './policy.mjs';

const integrationReasons = new Set(['same_commit', 'ancestor', 'trees_match', 'no_added_changes', 'merge_adds_nothing', 'patch_id_match']);
const codeRoot = fileURLToPath(new URL('../', import.meta.url));

export function inventoryContents(root, limits, { skipGit = true, visitEntry = () => {} } = {}) {
  let files = 0, bytes = 0, nested = false, links = false;
  const entries = [];
  function visit(directory, relative = '') {
    for (const name of fs.readdirSync(directory).sort()) {
      const child = path.join(directory, name);
      const key = path.join(relative, name);
      if (skipGit && !relative && name === '.git') continue;
      if (++files > limits.maxFiles) throw new Error('Content inventory exceeds file limit');
      const stat = fs.lstatSync(child, { bigint: true });
      visitEntry(key, stat);
      if (name === '.git') nested = true;
      if (stat.isSymbolicLink()) { links = true; entries.push([key, 'link']); }
      else if (stat.isDirectory()) { entries.push([key, 'directory']); visit(child, key); }
      else if (stat.isFile()) {
        const size = Number(stat.size);
        bytes += size;
        if (!Number.isSafeInteger(bytes) || bytes > limits.maxBytes) throw new Error('Content inventory exceeds byte limit');
        const before = fileIdentity(child);
        const unchanged = next => ['dev', 'ino', 'birthtimeNs', 'size', 'mtimeNs', 'ctimeNs'].every(key => stat[key] === next[key]);
        const fd = fs.openSync(child, 'r'), hasher = createHash('sha256');
        try {
          if (!unchanged(fs.fstatSync(fd, { bigint: true }))) throw new Error('Content changed during inventory');
          const buffer = Buffer.alloc(Math.min(size, 65536));
          let read = 0;
          while (read < size) {
            const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - read), null);
            if (!count) throw new Error('Content changed during inventory');
            hasher.update(buffer.subarray(0, count)); read += count;
          }
          if (!unchanged(fs.fstatSync(fd, { bigint: true }))) throw new Error('Content changed during inventory');
        } finally { fs.closeSync(fd); }
        const hash = hasher.digest('hex');
        const after = fs.lstatSync(child, { bigint: true });
        if (digest(before) !== digest(fileIdentity(child)) || stat.size !== after.size || stat.mtimeNs !== after.mtimeNs || stat.ctimeNs !== after.ctimeNs) throw new Error('Content changed during inventory');
        entries.push([key, 'file', size, hash]);
      } else throw new Error('Unsupported content type');
    }
  }
  visit(localPath(root));
  return { logicalBytes: bytes, physicalSavings: null, files, nested, links, fingerprint: digest(entries) };
}

export function validateObservation(value) {
  object(value, 'Worktrunk envelope');
  if (value.schema !== 2 || !Array.isArray(value.items) || value.collected?.ci !== false || value.collected?.summary !== false) throw new Error('Unsupported Worktrunk observation profile/schema');
  object(value.repo, 'Worktrunk repository');
  const observation = object(value.observation, 'Worktrunk isolated ref snapshot');
  for (const field of ['refs', 'targets']) {
    object(observation[field], `observation.${field}`);
    if (!Object.keys(observation[field]).length) throw new Error('Missing observation refs/targets');
    for (const [name, sha] of Object.entries(observation[field])) {
      text(name, 'ref name');
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) throw new Error('Invalid observed object ID');
    }
  }
  for (const [name, sha] of Object.entries(observation.targets)) {
    if (observation.refs[`refs/heads/${name}`] !== sha && observation.refs[`refs/remotes/${name}`] !== sha) throw new Error('Target is not bound to captured ref inventory');
  }
  return value;
}

export function scanProject(config, store, project, now = Date.now()) {
  return invocation(config, project.root, ({ git, wt }) => {
    const inventory = worktreeInventory(git);
    const beforeRefs = refVector(git);
    let envelope, failure;
    try {
      envelope = validateObservation(JSON.parse(wt(['list', '--format=json'])));
      if (digest(beforeRefs) !== digest(envelope.observation.refs) || digest(beforeRefs) !== digest(refVector(git)) || digest(inventory) !== digest(worktreeInventory(git))) throw new Error('Repository inventory changed during observation');
    } catch (error) { failure = error.message; }
    const items = new Map();
    try {
      if (!failure) for (const item of envelope.items) {
        if (!item.worktree) continue;
        const key = localPath(item.worktree.path, { missing: true });
        if (items.has(key)) throw new Error('Duplicate Worktrunk worktree observation');
        items.set(key, item);
      }
    } catch (error) { failure = error.message; }
    let decisions = inventory.map(entry => {
      const target = { kind: 'worktree', project: project.id, path: entry.path, branch: entry.branch ?? null, head: entry.HEAD ?? null };
      let evidence;
      try {
        if (failure) throw new Error(failure);
        const root = localPath(entry.path, { missing: true });
        const item = items.get(root);
        if (!item) throw new Error('Worktrunk item missing from inventory');
        if (entry.prunable || !fs.existsSync(root)) return { ...target, status: 'retain', reasons: ['stale_registration_report_only'], evidence: null };
        if (item.head?.sha !== entry.HEAD || (item.branch ? `refs/heads/${item.branch}` : null) !== (entry.branch ?? null)) throw new Error('Worktree HEAD/branch mismatch');
        const tree = object(item.worktree, 'worktree');
        for (const key of ['main', 'current', 'detached', 'branch_mismatch', 'duplicate_branch']) if (typeof tree[key] !== 'boolean') throw new Error(`Missing worktree fact: ${key}`);
        const changes = object(tree.changes, 'changes');
        for (const key of ['staged', 'modified', 'untracked', 'renamed', 'deleted', 'conflicted']) if (typeof changes[key] !== 'boolean') throw new Error(`Unknown change fact: ${key}`);
        if (tree.operation === null || item.default_branch === null) throw new Error('Unknown Worktrunk operation/integration facts');
        const integration = item.default_branch?.integration;
        if (integration === null || (integration && !integrationReasons.has(integration.reason))) throw new Error('Unknown Worktrunk integration result');
        const gitDir = localPath(git(['rev-parse', '--absolute-git-dir'], root).trim());
        const identity = inspectIdentity(store, root, gitDir)?.value ?? null;
        const contents = inventoryContents(root, config.limits);
        const status = git(['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none'], root);
        const records = status.split('\0');
        // Git status deliberately hides assume-unchanged and skip-worktree content.
        const hiddenIndex = git(['ls-files', '-v', '-z'], root).split('\0').some(record => /^[a-zS] /.test(record));
        evidence = {
          incarnation: fileIdentity(root), gitDir, identity: identity?.id ?? null, enrolledAt: identity?.enrolledAt ?? null,
          main: tree.main, defaultBranch: item.branch === envelope.repo.default_branch, locked: Boolean(entry.locked || tree.locked), stale: false,
          protectedPath: [process.cwd(), codeRoot, config.stateDir, config.quarantineDir].some(protectedRoot => overlap(root, localPath(protectedRoot, { missing: true }))),
          integration: integration?.reason ?? null, refs: beforeRefs, targets: envelope.observation.targets,
          hiddenIndex,
          dirty: hiddenIndex ? null : ['staged', 'modified', 'renamed', 'deleted', 'conflicted'].some(key => changes[key]) || records.some(record => /^[12u] /.test(record)),
          untracked: changes.untracked || records.some(record => record.startsWith('? ')), ignored: records.some(record => record.startsWith('! ')),
          operation: Boolean(tree.operation), nested: contents.nested, links: contents.links, contents,
          acceptedTask: false, inactiveProducers: false,
        };
        return { ...target, ...decideWorktree(evidence, config.policy, now), evidence };
      } catch (error) { return { ...target, status: 'analysis_failed', reasons: ['observation_unavailable'], error: error.message, evidence: null }; }
    });
    try {
      if (digest(beforeRefs) !== digest(refVector(git)) || digest(inventory) !== digest(worktreeInventory(git))) throw new Error('Repository inventory changed during content observation');
    } catch (error) { decisions = decisions.map(decision => ({ ...decision, status: 'analysis_failed', reasons: ['observation_unavailable'], error: error.message, evidence: null })); }
    return { version: 1, project: project.id, observedAt: now, policyGeneration: config.generation, applyEnabled: false, decisions: decisions.map(decision => ({ ...decision, id: digest({ policy: config.generation, ...decision }) })) };
  });
}
