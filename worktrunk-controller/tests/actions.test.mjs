import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { Store } from '../lib/store.mjs';
import { loadConfig } from '../lib/config.mjs';
import { enrollArtifact, inspectArtifact } from '../lib/artifacts.mjs';
import { quarantineArtifact, restore, reconcile, inspectQuarantine, purgeArtifact } from '../lib/actions.mjs';
import { sampleClock } from '../lib/retention.mjs';
import { fileIdentity } from '../lib/paths.mjs';
import { producerRoots } from '../lib/artifacts.mjs';
import { inactive, reserve } from '../lib/admission.mjs';
import { controller, git, nativeWorktrunk } from './helpers.mjs';

const host = process.platform === 'win32' ? nativeWorktrunk('wt-controller-host') : null;
const windows = { skip: process.platform !== 'win32' };

function worker(s, mode, id, checkpoint = '', gate = '') {
  const filename = fileURLToPath(new URL('./fixtures/action-worker.mjs', import.meta.url));
  const child = spawn(process.execPath, [filename, mode, s.filename, id, checkpoint, gate], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const done = once(child, 'exit').then(([code]) => ({ code, stdout, stderr }));
  return { child, done };
}

function setup(t) {
  let store;
  const s = controller({ after(cleanup) { t.after(() => { store?.close(); cleanup(); }); } }, process.execPath);
  const parent = path.join(s.base, 'cache parent'); fs.mkdirSync(parent);
  const root = path.join(parent, 'cache root א'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'generated'), 'reproducible content');
  const raw = JSON.parse(fs.readFileSync(s.filename));
  raw.policy.allowApply = true; raw.policy.minAgeMs = 0;
  raw.artifactRoots = [{ id: 'cache', path: root, owner: raw.host.id, projects: ['myproject'], managedOnly: true, producerAdmission: 'cooperative-windows-job-v1', retentionMs: 1000, classes: [{ path: '.', kind: 'reproducible_cache' }] }];
  if (host) raw.nativeHost = { path: host, sha256: createHash('sha256').update(fs.readFileSync(host)).digest('hex'), version: 1 };
  fs.writeFileSync(s.filename, JSON.stringify(raw));
  const config = loadConfig(s.filename); store = new Store(s.state);
  enrollArtifact(config, store, 'cache', 1000);
  const decision = inspectArtifact(config, store, 'cache', 2000);
  store.transaction(tx => tx.put('decision', decision.id, { version: 1, ...decision, policyGeneration: config.generation }));
  return { ...s, root, config, store, decision };
}

function expired(s, action) {
  const clock = sampleClock();
  const retentionClock = Object.fromEntries(Object.entries(clock).map(([key, value]) => [key, value - 10000]));
  s.store.transaction(tx => tx.put('action', action.id, { ...action, retentionClock }));
  const decision = inspectQuarantine(s.config, s.store, action.id);
  assert.equal(decision.status, 'eligible', JSON.stringify(decision));
  s.store.transaction(tx => tx.put('decision', decision.id, { version: 1, ...decision, policyGeneration: s.config.generation }));
  return decision;
}

test('quarantine review preserves baseline, enrollment and stable due decision identity', windows, t => {
  const s = setup(t), action = quarantineArtifact(s.config, s.store, s.decision.id);
  assert.deepEqual(action.baseline.contents, s.decision.evidence.contents);
  const pending = inspectQuarantine(s.config, s.store, action.id, action.retentionClock);
  assert.equal(pending.status, 'retain'); assert.ok(pending.reasons.includes('retention_pending'));
  const due = expired(s, action), clock = sampleClock();
  const later = Object.fromEntries(Object.entries(clock).map(([key, value]) => [key, value + 1000]));
  assert.equal(inspectQuarantine(s.config, s.store, action.id, later).id, due.id);
  assert.equal(fs.readFileSync(path.join(action.payloadPath, 'generated'), 'utf8'), 'reproducible content');
  assert.throws(() => inactive(s.store, s.config.projects[0].root, action.claimToken), /Own cleanup/);
  assert.equal(inactive(s.store, action.payloadPath), false);
  assert.equal(inactive(s.store, action.payloadPath, action.claimToken), true);
});

test('legacy clocks, protected or changed payloads and another unresolved owner veto purge', windows, t => {
  const s = setup(t), action = quarantineArtifact(s.config, s.store, s.decision.id);
  s.store.transaction(tx => tx.put('action', action.id, { ...action, retentionClock: null }));
  assert.ok(inspectQuarantine(s.config, s.store, action.id).reasons.includes('retention_clock_unknown'));
  expired(s, action);
  fs.writeFileSync(path.join(action.payloadPath, '.env'), 'protected');
  assert.ok(inspectQuarantine(s.config, s.store, action.id).reasons.includes('artifact_credentials'));
  fs.unlinkSync(path.join(action.payloadPath, '.env'));
  fs.writeFileSync(path.join(action.payloadPath, 'generated'), 'changed');
  assert.ok(inspectQuarantine(s.config, s.store, action.id).reasons.includes('quarantine_baseline_changed_or_unknown'));
  fs.writeFileSync(path.join(action.payloadPath, 'generated'), 'reproducible content');
  const producer = reserve(s.store, { roots: [s.config.projects[0].root], owner: 'other', sessionId: 'unknown' });
  fs.renameSync(s.config.projects[0].root, `${s.config.projects[0].root}-retained`);
  assert.ok(inspectQuarantine(s.config, s.store, action.id).reasons.includes('active_or_unresolved_producers'));
  assert.equal(s.store.get('claim', producer.token).value.state, 'reserved');
});

test('selected purge deletes only cache descendants and preserves enrolled root for producers', windows, t => {
  const s = setup(t), before = fileIdentity(s.root), action = quarantineArtifact(s.config, s.store, s.decision.id);
  const sentinel = path.join(s.base, 'unrelated'); fs.writeFileSync(sentinel, 'keep');
  const decision = expired(s, action);
  assert.throws(() => purgeArtifact({ ...s.config, policy: { ...s.config.policy, allowApply: false } }, s.store, decision.id), /disabled/);
  assert.throws(() => purgeArtifact(s.config, s.store, s.decision.id), /eligible artifact purge/);
  const purged = purgeArtifact(s.config, s.store, decision.id);
  assert.equal(purged.phase, 'purged'); assert.equal(purged.purgeOutcome, 'complete');
  assert.deepEqual(fileIdentity(s.root), before); assert.deepEqual(fs.readdirSync(s.root), []);
  assert.equal(fs.existsSync(action.payloadPath), false); assert.equal(inactive(s.store, s.root), true);
  assert.equal(reserve(s.store, { roots: producerRoots(s.config, s.store, 'myproject', s.config.projects[0].root), owner: 'host', sessionId: 'after-purge' }).state, 'reserved');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
  assert.equal(reconcile(s.config, s.store, action.id).phase, 'purged');
  assert.throws(() => purgeArtifact(s.config, s.store, decision.id), /decision changed/);
});

test('failed purge intent changes no bytes and changed selected content refuses deletion', windows, t => {
  const s = setup(t), action = quarantineArtifact(s.config, s.store, s.decision.id), decision = expired(s, action);
  s.store.db.exec("CREATE TRIGGER fail_purge BEFORE UPDATE ON records WHEN NEW.kind='action' AND json_extract(NEW.body,'$.phase')='purging' BEGIN SELECT RAISE(ABORT,'purge intent failed'); END;");
  assert.throws(() => purgeArtifact(s.config, s.store, decision.id), /purge intent failed/);
  assert.equal(s.store.get('action', action.id).value.phase, 'quarantined');
  assert.equal(fs.readFileSync(path.join(action.payloadPath, 'generated'), 'utf8'), 'reproducible content');
  s.store.db.exec('DROP TRIGGER fail_purge');
  fs.writeFileSync(path.join(action.payloadPath, 'generated'), 'changed after selection');
  assert.throws(() => purgeArtifact(s.config, s.store, decision.id), /decision changed/);
  assert.equal(fs.readFileSync(path.join(action.payloadPath, 'generated'), 'utf8'), 'changed after selection');
});

test('failed purge completion recovers empty original without repeating deletion', windows, t => {
  const s = setup(t), action = quarantineArtifact(s.config, s.store, s.decision.id), decision = expired(s, action);
  s.store.db.exec("CREATE TRIGGER fail_completion BEFORE UPDATE ON records WHEN NEW.kind='action' AND json_extract(NEW.body,'$.phase')='purged' BEGIN SELECT RAISE(ABORT,'completion failed'); END;");
  assert.throws(() => purgeArtifact(s.config, s.store, decision.id), /completion failed/);
  assert.equal(s.store.get('action', action.id).value.phase, 'purging');
  assert.deepEqual(fs.readdirSync(s.root), []); assert.equal(s.store.get('claim', action.claimToken).value.state, 'held');
  s.store.db.exec('DROP TRIGGER fail_completion');
  assert.equal(reconcile(s.config, s.store, action.id).phase, 'purged');
  assert.equal(s.store.get('claim', action.claimToken).value.state, 'released');
});

for (const checkpoint of ['after-purge-intent', 'before-delete', 'after-one-delete', 'before-rename', 'after-rename']) {
  test(`killed purge at ${checkpoint} never retries uncertain deletion`, windows, async t => {
    const s = setup(t);
    fs.writeFileSync(path.join(s.root, 'z-remaining'), 'keep until selected purge');
    const selected = inspectArtifact(s.config, s.store, 'cache');
    s.store.transaction(tx => tx.put('decision', selected.id, { version: 1, ...selected, policyGeneration: s.config.generation }));
    const action = quarantineArtifact(s.config, s.store, selected.id), decision = expired(s, action);
    const run = worker(s, 'purge', decision.id, checkpoint);
    try {
      await Promise.race([once(run.child.stdout, 'data'), run.done.then(result => { throw new Error(result.stderr); })]);
    } finally { run.child.kill('SIGKILL'); await run.done; }
    assert.equal(s.store.get('action', action.id).value.phase, 'purging');
    const restarted = new Store(s.state);
    try {
      const recovered = reconcile(s.config, restarted, action.id);
      if (checkpoint === 'after-rename') {
        assert.equal(recovered.phase, 'purged'); assert.deepEqual(fs.readdirSync(s.root), []);
        assert.equal(restarted.get('claim', action.claimToken).value.state, 'released');
      } else {
        assert.equal(recovered.phase, 'quarantined'); assert.equal(recovered.purgeOutcome, 'interrupted');
        assert.equal(recovered.retentionClock, null); assert.equal(restarted.get('claim', action.claimToken).value.state, 'held');
        assert.ok(inspectQuarantine(s.config, restarted, action.id).reasons.includes('interrupted_purge_restore_only'));
        assert.throws(() => purgeArtifact(s.config, restarted, decision.id), /decision changed/);
        const restored = restore(s.config, restarted, action.id);
        assert.equal(restored.purgeOutcome, 'interrupted');
        assert.deepEqual(fs.readdirSync(s.root), checkpoint === 'before-rename' ? [] : checkpoint === 'after-one-delete' ? ['z-remaining'] : ['generated', 'z-remaining']);
      }
    } finally { restarted.close(); }
  });
}

test('on-disk policy change after purge intent prevents deletion', windows, async t => {
  const s = setup(t), action = quarantineArtifact(s.config, s.store, s.decision.id), decision = expired(s, action);
  const gate = path.join(s.base, 'continue'), run = worker(s, 'purge', decision.id, 'after-purge-intent', gate);
  try {
    await Promise.race([once(run.child.stdout, 'data'), run.done.then(result => { throw new Error(result.stderr); })]);
    const raw = JSON.parse(fs.readFileSync(s.filename)); raw.policy.allowApply = false;
    fs.writeFileSync(s.filename, JSON.stringify(raw)); fs.writeFileSync(gate, 'continue');
    const result = await run.done; assert.equal(result.code, 1, result.stdout); assert.match(result.stderr, /Configuration changed/);
    assert.equal(fs.readFileSync(path.join(action.payloadPath, 'generated'), 'utf8'), 'reproducible content');
    const config = loadConfig(s.filename);
    assert.equal(reconcile(config, s.store, action.id).purgeOutcome, 'interrupted');
    assert.equal(restore(config, s.store, action.id).phase, 'restored');
  } finally { fs.writeFileSync(gate, 'continue'); run.child.kill('SIGKILL'); await run.done; }
});

test('purge serializes reconciliation and competing purge controllers', windows, async t => {
  const s = setup(t), action = quarantineArtifact(s.config, s.store, s.decision.id), decision = expired(s, action);
  const gate = path.join(s.base, 'continue'), run = worker(s, 'purge', decision.id, 'before-delete', gate);
  let recovery, competing;
  try {
    await Promise.race([once(run.child.stdout, 'data'), run.done.then(result => { throw new Error(result.stderr); })]);
    recovery = worker(s, 'reconcile', action.id, 'starting');
    competing = worker(s, 'purge', decision.id, 'starting');
    await Promise.all([once(recovery.child.stdout, 'data'), once(competing.child.stdout, 'data')]);
    await setTimeout(100); assert.equal(recovery.child.exitCode, null); assert.equal(competing.child.exitCode, null);
    fs.writeFileSync(gate, 'continue');
    const [purged, reconciled, other] = await Promise.all([run.done, recovery.done, competing.done]);
    assert.equal(purged.code, 0, purged.stderr); assert.equal(reconciled.code, 0, reconciled.stderr); assert.equal(other.code, 1, other.stdout);
    assert.equal(s.store.get('action', action.id).value.phase, 'purged'); assert.deepEqual(fs.readdirSync(s.root), []);
  } finally {
    fs.writeFileSync(gate, 'continue'); run.child.kill('SIGKILL'); await run.done;
    for (const current of [recovery, competing]) if (current) { current.child.kill('SIGKILL'); await current.done; }
  }
});

test('real CLI selects a due quarantine after native elapsed retention and purges only its contents', windows, async t => {
  const s = setup(t), cli = fileURLToPath(new URL('../bin/controller.mjs', import.meta.url));
  const action = quarantineArtifact(s.config, s.store, s.decision.id);
  const invoke = args => spawnSync(process.execPath, [cli, ...args, '--config', s.filename, '--format', 'json'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  for (const args of [['purge'], ['purge', '--action', action.id], ['scan', '--action', action.id, '--project', 'myproject']]) assert.equal(invoke(args).status, 1);
  const first = invoke(['scan', '--action', action.id]); assert.equal(first.status, 0, first.stderr);
  const initial = JSON.parse(first.stdout).artifacts[0];
  assert.ok(['retain', 'eligible'].includes(initial.status), first.stdout);
  if (initial.status === 'retain') assert.ok(initial.reasons.includes('retention_pending'), first.stdout);
  assert.equal(fs.readFileSync(path.join(action.payloadPath, 'generated'), 'utf8'), 'reproducible content');
  await setTimeout(2200);
  const scanned = invoke(['scan', '--action', action.id]); assert.equal(scanned.status, 0, scanned.stderr);
  const selected = JSON.parse(scanned.stdout).artifacts[0]; assert.equal(selected.status, 'eligible', scanned.stdout);
  assert.equal(invoke(['apply', '--decision', selected.id]).status, 1);
  const purged = invoke(['purge', '--decision', selected.id]); assert.equal(purged.status, 0, purged.stderr);
  assert.equal(JSON.parse(purged.stdout).phase, 'purged'); assert.deepEqual(fs.readdirSync(s.root), []);
  const reported = invoke(['report', '--from', '1970-01-01', '--to', '2026-01-01']); assert.equal(reported.status, 0, reported.stderr);
  assert.equal(JSON.parse(reported.stdout).actions[0].purgeOutcome, 'complete');
});

test('partial removal failure records error and restores only remaining contents', windows, async t => {
  const s = setup(t); fs.writeFileSync(path.join(s.root, 'z-remaining'), 'remaining');
  const selected = inspectArtifact(s.config, s.store, 'cache');
  s.store.transaction(tx => tx.put('decision', selected.id, { version: 1, ...selected, policyGeneration: s.config.generation }));
  const action = quarantineArtifact(s.config, s.store, selected.id), decision = expired(s, action);
  const run = worker(s, 'purge', decision.id, 'fail-after-one-delete');
  const result = await run.done; assert.equal(result.code, 1, result.stdout);
  const failed = s.store.get('action', action.id).value;
  assert.equal(failed.phase, 'purging'); assert.match(failed.error, /descendant removal failure/);
  assert.equal(reconcile(s.config, s.store, action.id).purgeOutcome, 'interrupted');
  assert.equal(restore(s.config, s.store, action.id).purgeOutcome, 'interrupted');
  assert.deepEqual(fs.readdirSync(s.root), ['z-remaining']); assert.equal(fs.readFileSync(path.join(s.root, 'z-remaining'), 'utf8'), 'remaining');
});

test('retention cannot be shortened and current ownership or protected policy changes veto purge', windows, t => {
  const s = setup(t), action = quarantineArtifact(s.config, s.store, s.decision.id), clock = sampleClock();
  s.store.transaction(tx => tx.put('action', action.id, { ...action, retentionMs: 100000 }));
  const later = Object.fromEntries(Object.entries(clock).map(([key, value]) => [key, value + 10000]));
  assert.ok(inspectQuarantine(s.config, s.store, action.id, later).reasons.includes('retention_pending'));
  expired(s, action);
  const raw = JSON.parse(fs.readFileSync(s.filename)); raw.artifactRoots[0].retentionMs = 100000;
  fs.writeFileSync(s.filename, JSON.stringify(raw));
  assert.ok(inspectQuarantine(loadConfig(s.filename), s.store, action.id).reasons.includes('retention_pending'));
  raw.artifactRoots[0].retentionMs = 1; raw.artifactRoots[0].classes[0].kind = 'evidence';
  fs.writeFileSync(s.filename, JSON.stringify(raw));
  assert.ok(inspectQuarantine(loadConfig(s.filename), s.store, action.id).reasons.includes('artifact_evidence'));
  raw.artifactRoots[0].owner = 'other'; fs.writeFileSync(s.filename, JSON.stringify(raw));
  const changed = inspectQuarantine(loadConfig(s.filename), s.store, action.id);
  assert.ok(changed.reasons.includes('artifact_owner_mismatch')); assert.ok(changed.reasons.includes('unmanaged_incarnation'));
});

test('selected artifact quarantine preserves content and holds both path fences', windows, t => {
  const s = setup(t);
  assert.equal(s.decision.status, 'eligible');
  const action = quarantineArtifact(s.config, s.store, s.decision.id);
  assert.equal(action.phase, 'quarantined');
  assert.equal(fs.existsSync(s.root), false);
  assert.equal(fs.readFileSync(path.join(action.payloadPath, 'generated'), 'utf8'), 'reproducible content');
  assert.throws(() => reserve(s.store, { roots: [action.payloadPath], owner: 'host', sessionId: 'blocked' }), /Cleanup/);
  fs.mkdirSync(s.root);
  assert.throws(() => reserve(s.store, { roots: [s.root], owner: 'host', sessionId: 'blocked-original' }), /Cleanup/);
  assert.equal(reserve(s.store, { roots: [s.config.projects[0].root], owner: 'host', sessionId: 'unrelated' }).state, 'reserved');
});

test('disabled apply and changed selected evidence never move artifact content', t => {
  const s = setup(t);
  assert.throws(() => quarantineArtifact({ ...s.config, policy: { ...s.config.policy, allowApply: false } }, s.store, s.decision.id), /disabled/);
  assert.equal(s.store.list('action').length, 0);
  if (process.platform !== 'win32') {
    assert.throws(() => quarantineArtifact(s.config, s.store, s.decision.id), /eligible artifact decision/);
    return;
  }
  fs.writeFileSync(path.join(s.root, 'generated'), 'changed after decision');
  assert.throws(() => quarantineArtifact(s.config, s.store, s.decision.id), /decision changed/);
  assert.equal(fs.readFileSync(path.join(s.root, 'generated'), 'utf8'), 'changed after decision');
  const action = s.store.list('action')[0].value;
  assert.equal(action.phase, 'prepared');
  assert.equal(fs.existsSync(action.payloadPath), false);
  assert.equal(s.store.get('claim', action.claimToken).value.state, 'held');
});

test('failed intent persistence prevents container creation and artifact movement', windows, t => {
  const s = setup(t);
  s.store.db.exec("CREATE TRIGGER fail_intent BEFORE INSERT ON records WHEN NEW.kind='action' BEGIN SELECT RAISE(ABORT,'intent failed'); END;");
  assert.throws(() => quarantineArtifact(s.config, s.store, s.decision.id), /intent failed/);
  assert.equal(s.store.list('action').length, 0); assert.equal(s.store.list('claim').length, 0);
  assert.equal(fs.existsSync(s.config.quarantineDir), false);
  assert.equal(fs.readFileSync(path.join(s.root, 'generated'), 'utf8'), 'reproducible content');
});

test('restore preserves bytes and enrollment after cleanup policy is disabled or changed', windows, t => {
  const s = setup(t), action = quarantineArtifact(s.config, s.store, s.decision.id);
  const raw = JSON.parse(fs.readFileSync(s.filename));
  raw.policy.allowApply = false; raw.artifactRoots[0].classes[0].kind = 'unknown';
  fs.writeFileSync(s.filename, JSON.stringify(raw));
  const config = loadConfig(s.filename);
  assert.notEqual(config.generation, s.config.generation);
  const restored = restore(config, s.store, action.id);
  assert.equal(restored.phase, 'restored');
  assert.equal(fs.readFileSync(path.join(s.root, 'generated'), 'utf8'), 'reproducible content');
  assert.equal(fs.existsSync(action.payloadPath), false);
  assert.equal(inactive(s.store, s.root), true);
  assert.equal(restore(config, s.store, action.id).phase, 'restored');
  assert.equal(reconcile(config, s.store, action.id).phase, 'restored');
  assert.ok(inspectArtifact(config, s.store, 'cache').evidence.identity);
});

test('occupied originals and replaced containers preserve quarantined payloads and held claims', windows, t => {
  const s = setup(t), action = quarantineArtifact(s.config, s.store, s.decision.id);
  fs.mkdirSync(s.root); fs.writeFileSync(path.join(s.root, 'new'), 'new owner');
  assert.throws(() => restore(s.config, s.store, action.id), /ambiguous/);
  assert.throws(() => reconcile(s.config, s.store, action.id), /ambiguous/);
  assert.equal(fs.readFileSync(path.join(s.root, 'new'), 'utf8'), 'new owner');
  assert.equal(fs.readFileSync(path.join(action.payloadPath, 'generated'), 'utf8'), 'reproducible content');
  fs.renameSync(action.containerPath, path.join(s.base, 'retained-container')); fs.mkdirSync(action.containerPath);
  assert.throws(() => restore(s.config, s.store, action.id), /container incarnation/);
  assert.equal(s.store.get('claim', action.claimToken).value.state, 'held');
});

test('replaced original parents and missing payloads keep recovery unresolved', windows, t => {
  const s = setup(t), action = quarantineArtifact(s.config, s.store, s.decision.id);
  const parent = path.dirname(s.root);
  fs.renameSync(parent, `${parent}-retained`); fs.mkdirSync(parent);
  assert.throws(() => restore(s.config, s.store, action.id), /parent incarnation/);
  assert.throws(() => reconcile(s.config, s.store, action.id), /parent incarnation/);
  assert.equal(fs.readFileSync(path.join(action.payloadPath, 'generated'), 'utf8'), 'reproducible content');
  fs.renameSync(parent, `${parent}-replacement`); fs.renameSync(`${parent}-retained`, parent);
  fs.renameSync(action.payloadPath, path.join(s.base, 'retained-payload'));
  assert.throws(() => reconcile(s.config, s.store, action.id), /ambiguous/);
  assert.equal(s.store.get('claim', action.claimToken).value.state, 'held');
});

for (const direction of ['quarantined', 'restored']) {
  test(`failed ${direction} completion write recovers the filesystem outcome`, windows, t => {
    const s = setup(t);
    const prior = direction === 'restored' ? quarantineArtifact(s.config, s.store, s.decision.id) : null;
    s.store.db.exec(`CREATE TRIGGER fail_completion BEFORE UPDATE ON records WHEN NEW.kind='action' AND json_extract(NEW.body,'$.phase')='${direction}' BEGIN SELECT RAISE(ABORT,'completion failed'); END;`);
    assert.throws(() => prior ? restore(s.config, s.store, prior.id) : quarantineArtifact(s.config, s.store, s.decision.id), /completion failed/);
    const action = s.store.list('action')[0].value;
    assert.equal(action.phase, prior ? 'restoring' : 'prepared');
    assert.equal(s.store.get('claim', action.claimToken).value.state, 'held');
    const retained = prior ? s.root : action.payloadPath;
    assert.equal(fs.readFileSync(path.join(retained, 'generated'), 'utf8'), 'reproducible content');
    s.store.db.exec('DROP TRIGGER fail_completion');
    assert.equal(reconcile(s.config, s.store, action.id).phase, direction);
    if (!prior) restore(s.config, s.store, action.id);
    assert.equal(inactive(s.store, s.root), true);
  });
}

test('competing apply controllers create only one action and payload', windows, async t => {
  const s = setup(t);
  const results = await Promise.all([worker(s, 'apply', s.decision.id).done, worker(s, 'apply', s.decision.id).done]);
  assert.equal(results.filter(result => result.code === 0).length, 1, JSON.stringify(results));
  assert.equal(s.store.list('action').length, 1);
  const action = s.store.list('action')[0].value;
  assert.equal(action.phase, 'quarantined');
  assert.equal(fs.readFileSync(path.join(action.payloadPath, 'generated'), 'utf8'), 'reproducible content');
  restore(s.config, s.store, action.id);
});

for (const change of ['disable', 'classification']) {
  test(`on-disk ${change} policy change during apply prevents the move`, windows, async t => {
    const s = setup(t), gate = path.join(s.base, 'continue');
    const run = worker(s, 'apply', s.decision.id, 'before-container', gate);
    try {
      await Promise.race([once(run.child.stdout, 'data'), run.done.then(result => { throw new Error(result.stderr); })]);
      const raw = JSON.parse(fs.readFileSync(s.filename));
      if (change === 'disable') raw.policy.allowApply = false;
      else raw.artifactRoots[0].classes[0].kind = 'evidence';
      fs.writeFileSync(s.filename, JSON.stringify(raw)); fs.writeFileSync(gate, 'continue');
      const result = await run.done;
      assert.equal(result.code, 1, result.stdout); assert.match(result.stderr, /Configuration changed/);
      assert.equal(fs.readFileSync(path.join(s.root, 'generated'), 'utf8'), 'reproducible content');
      const action = s.store.list('action')[0].value;
      assert.equal(action.phase, 'prepared'); assert.equal(fs.existsSync(action.payloadPath), false);
      assert.equal(s.store.get('claim', action.claimToken).value.state, 'held');
      assert.equal(reconcile(loadConfig(s.filename), s.store, action.id).phase, 'cancelled');
    } finally { fs.writeFileSync(gate, 'continue'); run.child.kill('SIGKILL'); await run.done; }
  });
}

test('CLI selects only artifact decisions and reports and restores journaled actions', windows, t => {
  const s = setup(t), binary = nativeWorktrunk();
  const raw = JSON.parse(fs.readFileSync(s.filename));
  raw.worktrunk.path = binary; raw.worktrunk.sha256 = createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
  fs.writeFileSync(s.filename, JSON.stringify(raw));
  const projectRoot = s.config.projects[0].root;
  git(projectRoot, 'config', 'worktrunk.default-branch', 'main');
  const sentinel = path.join(projectRoot, 'unrelated'); fs.writeFileSync(sentinel, 'keep');
  const cli = fileURLToPath(new URL('../bin/controller.mjs', import.meta.url));
  const invoke = args => spawnSync(process.execPath, [cli, ...args, '--config', s.filename, '--format', 'json'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  for (const args of [['apply'], ['restore'], ['reconcile'], ['apply', '--action', 'anything'], ['purge']]) assert.equal(invoke(args).status, 1);
  assert.equal(s.store.list('action').length, 0);
  const scanned = invoke(['scan']); assert.equal(scanned.status, 0, scanned.stderr);
  const snapshot = JSON.parse(scanned.stdout);
  assert.equal(snapshot.worktreeApplyEnabled, false); assert.equal(snapshot.applyEnabled, true);
  assert.equal(invoke(['apply', '--decision', snapshot.projects[0].decisions[0].id]).status, 1);
  const selected = snapshot.artifacts[0]; assert.equal(selected.status, 'eligible');
  const applied = invoke(['apply', '--decision', selected.id]); assert.equal(applied.status, 0, applied.stderr);
  const action = JSON.parse(applied.stdout); assert.equal(action.phase, 'quarantined');
  raw.policy.allowApply = false; raw.artifactRoots[0].classes[0].kind = 'unknown';
  fs.writeFileSync(s.filename, JSON.stringify(raw));
  const before = fs.readFileSync(path.join(s.state, 'controller.sqlite'));
  const reported = invoke(['report', '--from', '1970-01-01', '--to', '2026-01-01']);
  assert.equal(reported.status, 0, reported.stderr);
  assert.equal(JSON.parse(reported.stdout).actions[0].phase, 'quarantined');
  assert.deepEqual(fs.readFileSync(path.join(s.state, 'controller.sqlite')), before);
  const reconciled = invoke(['reconcile', '--action', action.id]); assert.equal(reconciled.status, 0, reconciled.stderr);
  const restored = invoke(['restore', '--action', action.id]); assert.equal(restored.status, 0, restored.stderr);
  assert.equal(JSON.parse(restored.stdout).phase, 'restored');
  assert.equal(fs.readFileSync(path.join(s.root, 'generated'), 'utf8'), 'reproducible content');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
});

for (const checkpoint of ['before-container', 'after-container', 'before-rename', 'after-rename']) {
  test(`killed quarantine at ${checkpoint} reconciles only a proven location`, windows, async t => {
    const s = setup(t), run = worker(s, 'apply', s.decision.id, checkpoint);
    try {
      const signal = await Promise.race([once(run.child.stdout, 'data'), run.done.then(result => { throw new Error(result.stderr); })]);
      assert.match(String(signal[0]), new RegExp(checkpoint));
    } finally { run.child.kill('SIGKILL'); await run.done; }
    const action = s.store.list('action')[0].value, restarted = new Store(s.state);
    try {
      if (checkpoint === 'after-container') {
        assert.throws(() => reconcile(s.config, restarted, action.id), /Unverified/);
        assert.equal(restarted.get('claim', action.claimToken).value.state, 'held');
        assert.equal(fs.readFileSync(path.join(s.root, 'generated'), 'utf8'), 'reproducible content');
      } else {
        const recovered = reconcile(s.config, restarted, action.id);
        assert.equal(recovered.phase, checkpoint === 'after-rename' ? 'quarantined' : 'cancelled');
        const root = recovered.phase === 'quarantined' ? recovered.payloadPath : recovered.originalPath;
        assert.equal(fs.readFileSync(path.join(root, 'generated'), 'utf8'), 'reproducible content');
        if (recovered.phase === 'quarantined') restore(s.config, restarted, action.id);
      }
    } finally { restarted.close(); }
  });
}

for (const checkpoint of ['before-rename', 'after-rename']) {
  test(`killed restore at ${checkpoint} recovers without repeating an uncertain rename`, windows, async t => {
    const s = setup(t), action = quarantineArtifact(s.config, s.store, s.decision.id);
    const run = worker(s, 'restore', action.id, checkpoint);
    try { await Promise.race([once(run.child.stdout, 'data'), run.done.then(result => { throw new Error(result.stderr); })]); }
    finally { run.child.kill('SIGKILL'); await run.done; }
    const recovered = reconcile(s.config, s.store, action.id);
    assert.equal(recovered.phase, checkpoint === 'before-rename' ? 'quarantined' : 'restored');
    if (recovered.phase === 'quarantined') restore(s.config, s.store, action.id);
    assert.equal(fs.readFileSync(path.join(s.root, 'generated'), 'utf8'), 'reproducible content');
    assert.equal(inactive(s.store, s.root), true);
  });
}

test('reconciliation serializes with a live move and competing controllers move only once', windows, async t => {
  const s = setup(t), gate = path.join(s.base, 'continue'), moving = worker(s, 'apply', s.decision.id, 'before-rename', gate);
  let recovery;
  try {
    await Promise.race([once(moving.child.stdout, 'data'), moving.done.then(result => { throw new Error(result.stderr); })]);
    const action = s.store.list('action')[0].value;
    recovery = worker(s, 'reconcile', action.id, 'starting');
    await Promise.race([once(recovery.child.stdout, 'data'), recovery.done.then(result => { throw new Error(result.stderr); })]);
    await setTimeout(100);
    assert.equal(recovery.child.exitCode, null);
    fs.writeFileSync(gate, 'continue');
    const results = await Promise.all([moving.done, recovery.done]);
    for (const result of results) { assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /quarantined/); }
    assert.equal(fs.existsSync(s.root), false);
    const restored = await Promise.all([worker(s, 'restore', action.id).done, worker(s, 'restore', action.id).done]);
    assert.ok(restored.some(result => result.code === 0));
    assert.equal(s.store.get('action', action.id).value.phase, 'restored');
    assert.equal(fs.readFileSync(path.join(s.root, 'generated'), 'utf8'), 'reproducible content');
  } finally {
    fs.writeFileSync(gate, 'continue'); moving.child.kill('SIGKILL'); await moving.done;
    if (recovery) { recovery.child.kill('SIGKILL'); await recovery.done; }
  }
});
