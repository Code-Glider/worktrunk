import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../lib/config.mjs';
import { localPath } from '../lib/paths.mjs';
import { repository } from './helpers.mjs';

function setup(t) {
  const repo = repository(t);
  const registry = path.join(repo.base, 'projects.json');
  fs.writeFileSync(registry, JSON.stringify({ projects: [{ id: 'myproject', root: './myproject' }] }));
  const config = { version: 1, host: { id: 'test-host', platform: process.platform }, registry, stateDir: repo.state, quarantineDir: path.join(repo.base, 'quarantine'), worktrunk: { path: process.execPath, sha256: 'a'.repeat(64), version: '0.81.0', schema: 2 }, policy: { generation: 1, minAgeMs: 86400000, retentionMs: 86400000, allowApply: false, deleteBranches: false }, limits: { timeoutMs: 10000, maxFiles: 1000, maxBytes: 10000000 }, artifactRoots: [] };
  const filename = path.join(repo.base, 'config.json');
  const load = () => { fs.writeFileSync(filename, JSON.stringify(config)); return loadConfig(filename); };
  return { ...repo, config, registry, load };
}

test('fresh configuration resolves the existing PMC registry without mutating it', t => {
  const setup_ = setup(t);
  const before = fs.readFileSync(setup_.registry);
  const config = setup_.load();
  assert.deepEqual(config.projects, [{ id: 'myproject', root: localPath(setup_.root) }]);
  assert.equal(config.policy.allowApply, false);
  assert.deepEqual(fs.readFileSync(setup_.registry), before);
  assert.equal(fs.existsSync(config.stateDir), false);
});

test('unsupported schemas, execution domains and incomplete inputs fail closed', t => {
  const s = setup(t);
  s.config.version = 2; assert.throws(s.load, /configuration version/); s.config.version = 1;
  s.config.worktrunk.schema = 1; assert.throws(s.load, /unpinned Worktrunk/); s.config.worktrunk.schema = 2;
  s.config.host.platform = 'other'; assert.throws(s.load, /execution domain/); s.config.host.platform = process.platform;
  delete s.config.policy.retentionMs; assert.throws(s.load, /retentionMs/);
});

test('native lifetime host is optional but must declare a pinned supported protocol', t => {
  const s = setup(t);
  assert.equal(s.load().nativeHost, null);
  s.config.nativeHost = { path: process.execPath, sha256: 'a'.repeat(64), version: 1 };
  const pinned = s.load(); assert.equal(pinned.nativeHost.version, 1);
  s.config.nativeHost.sha256 = 'unknown'; assert.throws(s.load, /unpinned native host/);
  s.config.nativeHost.sha256 = 'b'.repeat(64); assert.notEqual(s.load().generation, pinned.generation);
  s.config.nativeHost.version = 2; assert.throws(s.load, /unpinned native host/);
});

test('artifact roots require explicit ownership, literal classes and separate protected boundaries', t => {
  const s = setup(t), root = path.join(s.base, 'cache');
  fs.mkdirSync(root);
  const artifact = { id: 'cache', path: root, owner: 'test-host', projects: ['myproject'], managedOnly: true, retentionMs: 1000, classes: [{ path: '.', kind: 'reproducible_cache' }, { path: '.archon', kind: 'configuration' }] };
  s.config.artifactRoots = [artifact];
  const valid = s.load(); assert.equal(valid.artifactRoots[0].path, root);
  const helper = path.join(root, 'lifetime-host'); fs.writeFileSync(helper, 'pinned helper');
  s.config.nativeHost = { path: helper, sha256: 'a'.repeat(64), version: 1 }; assert.throws(s.load, /protected native host/); delete s.config.nativeHost;
  for (const relative of ['../outside', '/absolute', 'cache\\outside', 'C:outside', 'cache/*', 'cache//child']) {
    artifact.classes[0].path = relative; assert.throws(s.load, /literal relative/);
  }
  artifact.classes[0].path = '.';
  artifact.managedOnly = undefined; assert.throws(s.load, /managedOnly/); artifact.managedOnly = true;
  artifact.projects = ['missing']; assert.throws(s.load, /registered/); artifact.projects = ['myproject'];
  artifact.path = s.config.stateDir; assert.throws(s.load, /protected/);
  artifact.path = s.root; assert.throws(s.load, /protected/);
  artifact.path = root;
  s.config.artifactRoots.push({ ...artifact, id: 'duplicate-root' }); assert.throws(s.load, /must not overlap/);
  s.config.artifactRoots.pop();
  artifact.classes.push({ path: '.', kind: 'unknown' }); assert.throws(s.load, /duplicate artifact class/); artifact.classes.pop();
  artifact.classes[0].kind = 'configuration'; assert.notEqual(s.load().generation, valid.generation);
  const link = path.join(s.base, 'linked-cache'); fs.symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
  artifact.path = link; assert.throws(s.load, /Link traversal/);
});

test('duplicate registry IDs and state under a project are rejected', t => {
  const s = setup(t);
  fs.writeFileSync(s.registry, JSON.stringify({ version: 1, projects: [{ id: 'same', root: './myproject' }, { id: 'same', root: './myproject' }] }));
  assert.throws(s.load, /Duplicate project/);
  fs.writeFileSync(s.registry, JSON.stringify({ version: 1, projects: [{ id: 'one', root: './myproject' }] }));
  s.config.stateDir = path.join(s.root, 'state'); assert.throws(s.load, /outside registered projects/);
});

test('junction/symlink traversal is rejected at native path boundary', t => {
  const s = setup(t);
  const link = path.join(s.base, 'alias');
  fs.symlinkSync(s.root, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => localPath(path.join(link, 'anything'), { missing: true }), /Link traversal/);
});

test('event authorities require unique instances, explicit roles and registered projects', t => {
  const s = setup(t);
  const source = { id: 'tasks', instance: 'tracker-one', role: 'task', projects: ['myproject'], authority: 'issue-tracker' };
  s.config.eventSources = [source];
  assert.equal(s.load().eventSources[0].authority, 'issue-tracker');
  delete source.authority; assert.throws(s.load, /authority/); source.authority = 'issue-tracker';
  source.projects = ['outside']; assert.throws(s.load, /registered/); source.projects = ['myproject'];
  s.config.eventSources.push({ ...source, id: 'other' }); assert.throws(s.load, /Duplicate event source/);
});

test('optional paths may disappear after lstat without hiding links or required-path errors', t => {
  const s = setup(t), filename = path.join(s.base, 'transient-journal');
  const native = fs.realpathSync.native;
  t.mock.method(fs.realpathSync, 'native', value => {
    if (value === filename) fs.unlinkSync(filename);
    return native(value);
  });
  fs.writeFileSync(filename, 'journal');
  assert.equal(localPath(filename, { missing: true }), filename);
  fs.writeFileSync(filename, 'journal');
  assert.throws(() => localPath(filename), { code: 'ENOENT' });
});

test('optional Windows UNKNOWN resolution requires independently confirmed disappearance', t => {
  const s = setup(t), filename = path.join(s.base, 'transient-journal');
  const native = fs.realpathSync.native;
  let disappear = false;
  t.mock.method(fs.realpathSync, 'native', value => {
    if (value !== filename) return native(value);
    if (disappear) fs.unlinkSync(filename);
    throw Object.assign(new Error('Windows journal resolution failed'), { code: 'UNKNOWN' });
  });
  fs.writeFileSync(filename, 'journal');
  assert.throws(() => localPath(filename, { missing: true }), { code: 'UNKNOWN' });
  disappear = true;
  assert.equal(localPath(filename, { missing: true }), filename);
  fs.writeFileSync(filename, 'journal');
  assert.throws(() => localPath(filename), { code: 'UNKNOWN' });
});
