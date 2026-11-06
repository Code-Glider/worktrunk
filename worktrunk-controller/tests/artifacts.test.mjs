import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../lib/store.mjs';
import { enrollArtifact, inspectArtifact, producerRoots } from '../lib/artifacts.mjs';
import { acquireCleanup, reserve } from '../lib/admission.mjs';
import { decideArtifact } from '../lib/policy.mjs';
import { controller, git, nativeWorktrunk } from './helpers.mjs';
import { loadConfig } from '../lib/config.mjs';
import { report } from '../lib/report.mjs';
import { createHash } from 'node:crypto';

const binary = nativeWorktrunk();
const host = process.platform === 'win32' ? nativeWorktrunk('wt-controller-host') : null;

function setup(t, classes = [], executable = process.execPath) {
  let store;
  const s = controller({ after(cleanup) { t.after(() => { store?.close(); cleanup(); }); } }, executable), root = path.join(s.base, 'artifact root א');
  fs.mkdirSync(root);
  const value = JSON.parse(fs.readFileSync(s.filename));
  value.artifactRoots = [{ id: 'cache', path: root, owner: value.host.id, projects: ['myproject'], managedOnly: true, retentionMs: 1000, classes }];
  fs.writeFileSync(s.filename, JSON.stringify(value));
  const config = loadConfig(s.filename);
  store = new Store(s.state);
  return { ...s, config, store, artifact: root };
}

test('stale and ignored content has no inferred cache disposition; scans never enroll', t => {
  const s = setup(t);
  fs.writeFileSync(path.join(s.artifact, 'old.tmp'), 'unique old content');
  fs.utimesSync(path.join(s.artifact, 'old.tmp'), new Date(1), new Date(1));
  const scan = inspectArtifact(s.config, s.store, 'cache', 100000);
  assert.equal(scan.status, 'retain');
  assert.ok(scan.reasons.includes('artifact_unknown'));
  assert.ok(scan.reasons.includes('unmanaged_incarnation'));
  assert.equal(s.store.list('artifact_identity').length, 0);
  assert.equal(fs.readFileSync(path.join(s.artifact, 'old.tmp'), 'utf8'), 'unique old content');
});

test('artifact eligibility needs explicit cooperative opt-in and fresh native helper evidence', t => {
  const s = setup(t, [{ path: '.', kind: 'reproducible_cache' }]);
  fs.writeFileSync(path.join(s.artifact, 'cache'), 'reproducible');
  enrollArtifact(s.config, s.store, 'cache', 1000);
  assert.equal(inspectArtifact(s.config, s.store, 'cache', 100000).evidence.producerAdmission, false);
  s.config.artifactRoots[0].producerAdmission = 'cooperative-windows-job-v1';
  assert.equal(inspectArtifact(s.config, s.store, 'cache', 100000).status, 'retain');
  if (process.platform !== 'win32') {
    s.config.nativeHost = { path: process.execPath, sha256: 'a'.repeat(64), version: 1 };
    assert.equal(inspectArtifact(s.config, s.store, 'cache', 100000).evidence.producerAdmission, false);
    return;
  }
  s.config.nativeHost = { path: host, sha256: createHash('sha256').update(fs.readFileSync(host)).digest('hex'), version: 1 };
  const qualified = inspectArtifact(s.config, s.store, 'cache', 100000);
  assert.equal(qualified.status, 'eligible');
  assert.equal(qualified.evidence.nativeHost.sha256, s.config.nativeHost.sha256);
  s.config.artifactRoots[0].managedOnly = false;
  assert.equal(inspectArtifact(s.config, s.store, 'cache', 100000).status, 'retain');
  s.config.artifactRoots[0].managedOnly = true;
  s.config.nativeHost.sha256 = '0'.repeat(64);
  assert.equal(inspectArtifact(s.config, s.store, 'cache', 100000).status, 'analysis_failed');
  assert.equal(fs.readFileSync(path.join(s.artifact, 'cache'), 'utf8'), 'reproducible');
});

test('mixed roots protect agent configuration, credentials, evidence and unknown descendants after expiry', t => {
  const s = setup(t, [{ path: '.', kind: 'reproducible_cache' }, { path: 'evidence', kind: 'evidence' }, { path: 'evidence/cache', kind: 'reproducible_cache' }, { path: 'unknown', kind: 'unknown' }]);
  for (const relative of ['.archon/config.yaml', '.env', 'evidence/cache/trace', 'unknown/file', 'cache/generated']) {
    const filename = path.join(s.artifact, relative); fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, relative);
  }
  enrollArtifact(s.config, s.store, 'cache', 1000);
  const scan = inspectArtifact(s.config, s.store, 'cache', 100000);
  assert.equal(scan.status, 'retain');
  for (const kind of ['configuration', 'credentials', 'evidence', 'unknown']) assert.ok(scan.reasons.includes(`artifact_${kind}`));
  assert.equal(scan.evidence.classes.evidence, 3);
  assert.equal(scan.evidence.contents.physicalSavings, null);
  assert.equal(fs.readFileSync(path.join(s.artifact, '.archon/config.yaml'), 'utf8'), '.archon/config.yaml');
  const pure = { ...scan.evidence, classes: { reproducible_cache: 1, configuration: 0, credentials: 0, evidence: 0, unknown: 0 }, producerAdmission: true, inactiveProducers: true };
  assert.equal(decideArtifact(pure, s.config.policy, 100000).status, 'eligible');
  assert.equal(decideArtifact({ ...pure, classes: { ...pure.classes, evidence: 1 } }, s.config.policy, 100000).status, 'retain');
});

test('enrollment binds native incarnation and ownership; same-path recreation cannot inherit it', t => {
  const s = setup(t, [{ path: '.', kind: 'reproducible_cache' }]);
  const enrolled = enrollArtifact(s.config, s.store, 'cache', 1000);
  assert.ok(inspectArtifact(s.config, s.store, 'cache', 2000).evidence.identity === enrolled.id);
  fs.renameSync(s.artifact, path.join(s.base, 'retained-original'));
  fs.mkdirSync(s.artifact);
  const scan = inspectArtifact(s.config, s.store, 'cache', 2000);
  assert.ok(scan.reasons.includes('unmanaged_incarnation'));
  assert.throws(() => producerRoots(s.config, s.store, 'myproject', s.root), /matching ownership/);
  assert.throws(() => enrollArtifact(s.config, s.store, 'cache'), /explicit repair/);
});

test('artifact inventory includes Git metadata, refuses links and preserves bounded failures', t => {
  const s = setup(t, [{ path: '.', kind: 'reproducible_cache' }]);
  fs.mkdirSync(path.join(s.artifact, '.git')); fs.writeFileSync(path.join(s.artifact, '.git', 'config'), 'repository');
  let scan = inspectArtifact(s.config, s.store, 'cache');
  assert.equal(scan.evidence.contents.logicalBytes, 10);
  assert.ok(scan.reasons.includes('nested_repository'));
  const outside = path.join(s.base, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'sentinel'), 'outside');
  fs.symlinkSync(outside, path.join(s.artifact, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  scan = inspectArtifact(s.config, s.store, 'cache'); assert.ok(scan.reasons.includes('link_content'));
  scan = inspectArtifact({ ...s.config, limits: { ...s.config.limits, maxBytes: 1 } }, s.store, 'cache');
  assert.equal(scan.status, 'analysis_failed'); assert.equal(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'outside');
});

test('all declared producer roots are reserved atomically and unknown enrollment cannot admit launch', t => {
  const s = setup(t, [{ path: '.', kind: 'reproducible_cache' }]);
  assert.throws(() => producerRoots(s.config, s.store, 'myproject', s.root), /enrollment/);
  enrollArtifact(s.config, s.store, 'cache');
  const roots = producerRoots(s.config, s.store, 'myproject', s.root);
  assert.deepEqual(roots, [s.root, s.artifact]);
  acquireCleanup(s.store, { owner: 'cleanup', roots: [s.artifact] });
  assert.throws(() => reserve(s.store, { owner: 'host', sessionId: 'one', roots }), /Cleanup/);
  assert.equal(s.store.list('claim').filter(row => row.value.kind === 'producer').length, 0);
});

test('known enrollment clock rollback leaves growth unavailable', t => {
  const s = setup(t);
  enrollArtifact(s.config, s.store, 'cache', 10000);
  const previous = { observedAt: 1000, policyGeneration: s.config.generation, decision: inspectArtifact(s.config, s.store, 'cache', 1000) };
  fs.writeFileSync(path.join(s.artifact, 'generated'), '12');
  const latest = { version: 1, observedAt: 2000, policyGeneration: s.config.generation, decision: inspectArtifact(s.config, s.store, 'cache', 2000), previous };
  s.store.transaction(tx => tx.put('artifact_scan', 'cache', latest));
  assert.ok(latest.decision.reasons.includes('age_unknown'));
  assert.equal(report(s.config, s.store, { from: 1, to: 3000, now: 3000 }).artifactGrowthBytes, null);
});

test('a growing artifact cannot exceed the inventory read budget', t => {
  const s = setup(t), filename = path.join(s.artifact, 'growing');
  fs.writeFileSync(filename, '1');
  const lstat = fs.lstatSync, readFile = fs.readFileSync, read = fs.readSync;
  let appended = false, fileBytes = 0, streamBytes = 0;
  t.mock.method(fs, 'lstatSync', (file, options) => {
    const stat = lstat(file, options);
    if (file === filename && options?.bigint && !appended) { appended = true; fs.appendFileSync(filename, Buffer.alloc(1024 * 1024)); }
    return stat;
  });
  t.mock.method(fs, 'readFileSync', (file, ...args) => { const result = readFile(file, ...args); if (file === filename) fileBytes += result.length; return result; });
  t.mock.method(fs, 'readSync', (...args) => { const size = read(...args); streamBytes += size; return size; });
  const scan = inspectArtifact({ ...s.config, limits: { ...s.config.limits, maxBytes: 1 } }, s.store, 'cache');
  assert.equal(scan.status, 'analysis_failed');
  assert.ok(appended);
  assert.ok(Math.max(fileBytes, streamBytes) <= 1, `Read ${Math.max(fileBytes, streamBytes)} bytes with budget 1`);
});

test('CLI enrolls explicitly and two scan cycles report measured growth without changing artifacts', { timeout: 60000 }, t => {
  const s = setup(t, [{ path: '.', kind: 'reproducible_cache' }], binary);
  git(s.root, 'config', 'worktrunk.default-branch', 'main');
  const cli = fileURLToPath(new URL('../bin/controller.mjs', import.meta.url));
  const run = (command, extra = []) => spawnSync(process.execPath, [cli, command, '--config', s.filename, '--format', 'json', ...extra], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const enroll = run('enroll-artifact', ['--artifact', 'cache']);
  assert.equal(enroll.status, 0, enroll.stderr);
  fs.writeFileSync(path.join(s.artifact, 'generated'), '123');
  const first = run('scan'); assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).artifacts[0].evidence.contents.logicalBytes, 3);
  fs.appendFileSync(path.join(s.artifact, 'generated'), '4567');
  const second = run('scan'); assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).artifacts[0].status, 'retain');
  const now = Date.now() + 1;
  const read = () => report(s.config, s.store, { from: 1, to: now, now });
  assert.equal(read().artifactGrowthBytes, 4);
  assert.equal(read().artifacts[0].logicalBytes, 7);
  assert.equal(fs.readFileSync(path.join(s.artifact, 'generated'), 'utf8'), '1234567');
  const latest = s.store.get('artifact_scan', 'cache').value;
  assert.equal(report(s.config, s.store, { from: latest.previous.observedAt + 1, to: now, now }).artifactGrowthBytes, null);
  for (const observedAt of [latest.previous.observedAt - 1, latest.previous.observedAt]) {
    s.store.transaction(tx => tx.put('artifact_scan', 'cache', { ...latest, observedAt }));
    assert.equal(read().artifactGrowthBytes, null);
  }
  s.store.transaction(tx => tx.put('artifact_scan', 'cache', { ...latest, previous: { ...latest.previous, decision: { ...latest.previous.decision, evidence: { ...latest.previous.decision.evidence, identity: 'old-incarnation' } } } }));
  assert.equal(read().artifactGrowthBytes, null);
  assert.equal(report({ ...s.config, generation: 'changed-policy' }, s.store, { from: 1, to: now, now }).artifacts[0].logicalBytes, null);
});
