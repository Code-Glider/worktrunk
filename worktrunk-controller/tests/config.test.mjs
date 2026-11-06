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
