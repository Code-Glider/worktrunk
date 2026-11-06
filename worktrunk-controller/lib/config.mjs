import fs from 'node:fs';
import path from 'node:path';
import { digest, integer, object, text } from './data.mjs';
import { localPath, overlap } from './paths.mjs';

export function loadConfig(filename) {
  const value = object(JSON.parse(fs.readFileSync(localPath(filename), 'utf8')), 'configuration');
  if (value.version !== 1) throw new Error('Unsupported configuration version');
  const host = object(value.host, 'host');
  text(host.id, 'host.id');
  if (host.platform !== process.platform || !['win32', 'linux'].includes(host.platform)) throw new Error('Configuration execution domain does not match this native host');
  const wt = object(value.worktrunk, 'worktrunk');
  const executable = localPath(wt.path);
  if (!/^[a-f0-9]{64}$/.test(wt.sha256 ?? '') || wt.version !== '0.81.0' || wt.schema !== 2) throw new Error('Unsupported or unpinned Worktrunk executable/schema');
  const registryPath = localPath(value.registry);
  const registry = object(JSON.parse(fs.readFileSync(registryPath, 'utf8')), 'registry');
  if ((registry.version ?? 1) !== 1 || !Array.isArray(registry.projects)) throw new Error('Unsupported project registry');
  const ids = new Set();
  const projects = registry.projects.map(project => {
    object(project, 'project');
    const id = text(project.id, 'project.id');
    if (ids.has(id)) throw new Error(`Duplicate project: ${id}`);
    ids.add(id);
    const root = localPath(path.resolve(path.dirname(registryPath), text(project.root, 'project.root')));
    return { id, root };
  });
  const stateDir = localPath(value.stateDir, { missing: true });
  const quarantineDir = localPath(value.quarantineDir, { missing: true });
  if (overlap(stateDir, quarantineDir)) throw new Error('State and quarantine roots must be separate');
  for (const { root } of projects) {
    if (overlap(stateDir, root) || overlap(quarantineDir, root)) throw new Error('State/quarantine must be outside registered projects');
  }
  const policy = object(value.policy, 'policy');
  integer(policy.generation, 'policy.generation', 1);
  integer(policy.minAgeMs, 'policy.minAgeMs');
  integer(policy.retentionMs, 'policy.retentionMs', 1);
  if (typeof policy.allowApply !== 'boolean' || typeof policy.deleteBranches !== 'boolean') throw new Error('Explicit apply/branch policy required');
  const limits = object(value.limits, 'limits');
  for (const key of ['timeoutMs', 'maxFiles', 'maxBytes']) integer(limits[key], `limits.${key}`, 1);
  const artifactRoots = value.artifactRoots ?? [];
  if (!Array.isArray(artifactRoots)) throw new Error('artifactRoots must be an array');
  const sourceIds = new Set(), instances = new Set();
  if (value.eventSources !== undefined && !Array.isArray(value.eventSources)) throw new Error('eventSources must be an array');
  const eventSources = (value.eventSources ?? []).map(source => {
    object(source, 'event source');
    const id = text(source.id, 'source.id'), instance = text(source.instance, 'source.instance');
    if (sourceIds.has(id) || instances.has(instance)) throw new Error('Duplicate event source ID/instance');
    sourceIds.add(id); instances.add(instance);
    if (!['host', 'task'].includes(source.role)) throw new Error('Unsupported event source role');
    if (!Array.isArray(source.projects) || !source.projects.length || source.projects.some(id => !ids.has(id)) || new Set(source.projects).size !== source.projects.length) throw new Error('Source projects must be registered and unique');
    return { id, instance, role: source.role, projects: [...source.projects].sort(), authority: source.role === 'task' ? text(source.authority, 'source.authority') : null };
  });
  const normalized = { version: 1, host: { id: host.id, platform: host.platform }, worktrunk: { path: executable, sha256: wt.sha256, version: wt.version, schema: wt.schema }, projects, stateDir, quarantineDir, policy, limits, artifactRoots, eventSources };
  return { ...normalized, generation: digest(normalized) };
}
