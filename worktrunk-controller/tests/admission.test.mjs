import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { Store } from '../lib/store.mjs';
import { acquireCleanup, inactive, releaseCleanup, reserve, transition } from '../lib/admission.mjs';
import { child, fixture } from './helpers.mjs';
import { fileIdentity } from '../lib/paths.mjs';

function setup(t) {
  let store;
  const base = fixture(t, () => store?.close()), root = path.join(base, 'owned'), state = path.join(base, 'state');
  fs.mkdirSync(root); fs.mkdirSync(path.join(root, 'child'));
  store = new Store(state);
  return { base, root, state, store };
}

test('independent launch and cleanup contenders cannot both acquire an overlapping root', async t => {
  const s = setup(t);
  const results = await Promise.all([child('claim-producer', s.state, s.root).done, child('claim-cleanup', s.state, path.join(s.root, 'child')).done]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal(results.filter(result => result.stdout.startsWith('claimed')).length, 1);
  assert.equal(results.filter(result => result.stdout.startsWith('blocked')).length, 1);
  assert.equal(s.store.list('claim').length, 1);
});

test('multi-root claims are atomic; producers coexist and cleanup blocks descendant admission', t => {
  const s = setup(t), other = path.join(s.base, 'other'); fs.mkdirSync(other);
  reserve(s.store, { roots: [s.root], owner: 'host', sessionId: 'one' });
  reserve(s.store, { roots: [s.root], owner: 'host', sessionId: 'two' });
  assert.throws(() => acquireCleanup(s.store, { roots: [other, s.root], owner: 'host' }), /owner/);
  const cleanup = acquireCleanup(s.store, { roots: [other], owner: 'host' });
  fs.mkdirSync(path.join(other, 'child'));
  assert.throws(() => reserve(s.store, { roots: [path.join(other, 'child')], owner: 'host', sessionId: 'three' }), /Cleanup/);
  releaseCleanup(s.store, cleanup.token);
  assert.equal(reserve(s.store, { roots: [other], owner: 'host', sessionId: 'three' }).state, 'reserved');
  assert.equal(s.store.list('claim').length, 4);
});

test('killed reservations and unknown/PID-reused lifetime evidence remain protected after restart', async t => {
  const s = setup(t), run = child('claim-interrupt', s.state, s.root);
  await Promise.race([once(run.process.stdout, 'data'), run.done.then(result => { throw new Error(result.stderr); })]);
  run.process.kill('SIGKILL'); await run.done;
  const record = s.store.list('claim')[0].value;
  assert.equal(record.state, 'reserved');
  transition(s.store, record.token, 'reserved', 'starting');
  assert.throws(() => transition(s.store, record.token, 'starting', 'ended', { helperPid: 123 }), /transition/);
  assert.throws(() => transition(s.store, record.token, 'starting', 'running', { kind: 'windows_job', helperPid: 123, launchToken: 'reused' }), /evidence/);
  const reopened = new Store(s.state);
  try { assert.equal(inactive(reopened, s.root), false); assert.throws(() => acquireCleanup(reopened, { roots: [s.root], owner: 'host' }), /unresolved/); }
  finally { reopened.close(); }
});

test('completion must match the admitted native lifetime, never an expired PID or lease', t => {
  const s = setup(t), record = reserve(s.store, { roots: [s.root], owner: 'host', sessionId: 'one' });
  transition(s.store, record.token, 'reserved', 'starting');
  const evidence = { kind: 'windows_job', launchToken: record.token, helperPid: 123, activeProcesses: null };
  transition(s.store, record.token, 'starting', 'running', evidence);
  assert.throws(() => transition(s.store, record.token, 'running', 'ended', { ...evidence, helperPid: 124, activeProcesses: 1 }), /match/);
  assert.throws(() => transition(s.store, record.token, 'running', 'ended', { ...evidence, activeProcesses: 2 }), /match/);
  assert.equal(inactive(s.store, s.root), false);
  transition(s.store, record.token, 'running', 'ended', { ...evidence, activeProcesses: 1 });
  assert.equal(inactive(s.store, s.root), true);
});

test('a moved root retains its native ownership and a recreated path cannot shed an unresolved claim', t => {
  const s = setup(t), moved = path.join(s.base, 'moved');
  reserve(s.store, { roots: [s.root], owner: 'host', sessionId: 'one' });
  fs.renameSync(s.root, moved);
  assert.equal(inactive(s.store, moved), false);
  assert.throws(() => acquireCleanup(s.store, { roots: [moved], owner: 'cleanup' }), /owner/);
  assert.equal(inactive(s.store, path.join(moved, 'child')), false);
  assert.throws(() => acquireCleanup(s.store, { roots: [path.join(moved, 'child')], owner: 'cleanup' }), /owner/);
  fs.mkdirSync(s.root);
  assert.equal(inactive(s.store, s.root), false);
});

test('a moved child cleanup claim blocks admission to its new parent and unrelated unknown topology', t => {
  const s = setup(t), other = path.join(s.base, 'other'); fs.mkdirSync(other);
  const original = path.join(s.root, 'child');
  acquireCleanup(s.store, { roots: [original], owner: 'cleanup' });
  fs.renameSync(original, path.join(other, 'child'));
  assert.throws(() => reserve(s.store, { roots: [other], owner: 'host', sessionId: 'one' }), /Cleanup/);
  assert.throws(() => reserve(s.store, { roots: [s.root], owner: 'host', sessionId: 'two' }), /Cleanup/);
});

test('cleanup claim and linked intent either commit together or both roll back', t => {
  const s = setup(t);
  s.store.db.exec("CREATE TRIGGER fail_intent BEFORE INSERT ON records WHEN NEW.kind='action' BEGIN SELECT RAISE(ABORT,'intent failed'); END;");
  assert.throws(() => acquireCleanup(s.store, { roots: [s.root], owner: 'host', actionId: 'one' }, (tx, claim) => {
    tx.put('action', 'one', { version: 1, claimToken: claim.token });
  }), /intent failed/);
  assert.equal(s.store.list('claim').length, 0);
  assert.equal(s.store.list('action').length, 0);
  assert.throws(() => acquireCleanup(s.store, { roots: [s.root], owner: 'host' }, async () => {}), /synchronous/);
  assert.equal(s.store.list('claim').length, 0);
});

test('linked intent reserves its future container against earlier and later parent producers', t => {
  for (const first of ['producer', 'cleanup']) {
    const s = setup(t), parent = path.join(s.base, 'quarantine'); fs.mkdirSync(parent);
    const containerPath = path.join(parent, 'future'), payloadPath = path.join(containerPath, 'payload');
    const producer = () => reserve(s.store, { roots: [parent], owner: 'host', sessionId: 'writer' });
    const cleanup = () => acquireCleanup(s.store, { roots: [s.root], owner: 'host', actionId: 'one' }, (tx, claim) => {
      tx.put('action', 'one', { version: 1, id: 'one', claimToken: claim.token, owner: claim.owner, originalPath: s.root, originalParent: fileIdentity(s.base), incarnation: fileIdentity(s.root), containerPath, containerIdentity: null, payloadPath, phase: 'intent' });
    });
    if (first === 'producer') {
      producer(); assert.throws(cleanup, /owner|claim/);
      assert.equal(s.store.list('action').length, 0);
      assert.equal(s.store.list('claim').length, 1);
    } else {
      const claim = cleanup(); assert.throws(producer, /Cleanup/);
      assert.equal(inactive(s.store, s.root, claim.token), true);
    }
    assert.equal(fs.existsSync(containerPath), false);
  }
});

test('only a bound journaled relocation fences the original and payload without blocking unrelated roots', t => {
  const s = setup(t), containerPath = path.join(s.base, 'container'), other = path.join(s.base, 'other');
  fs.mkdirSync(containerPath); fs.mkdirSync(other);
  const payloadPath = path.join(containerPath, 'payload');
  let action;
  const claim = acquireCleanup(s.store, { roots: [s.root], owner: 'host', actionId: 'one' }, (tx, claim) => {
    action = { version: 1, id: 'one', claimToken: claim.token, owner: claim.owner, originalPath: s.root, originalParent: fileIdentity(s.base), incarnation: fileIdentity(s.root), containerPath, containerIdentity: fileIdentity(containerPath), payloadPath, phase: 'prepared' };
    tx.put('action', action.id, action);
  });
  assert.equal(inactive(s.store, s.root), false);
  assert.equal(inactive(s.store, s.root, claim.token), true);
  assert.throws(() => inactive(s.store, s.root, 'wrong-token'), /Own cleanup claim/);
  assert.throws(() => releaseCleanup(s.store, claim.token), /verified action recovery/);
  reserve(s.store, { roots: [other], owner: 'host', sessionId: 'other-owner' });
  fs.renameSync(other, path.join(s.base, 'moved-producer'));
  assert.equal(inactive(s.store, s.root, claim.token), false);
  fs.renameSync(path.join(s.base, 'moved-producer'), other);
  fs.renameSync(s.root, payloadPath);
  assert.throws(() => reserve(s.store, { roots: [other], owner: 'host', sessionId: 'unknown-move' }), /Cleanup/);
  s.store.transaction(tx => {
    tx.put('action', action.id, { ...action, phase: 'quarantined' });
    tx.put('claim', claim.token, { ...claim, roots: [{ ...claim.roots[0], currentPath: payloadPath }] });
  });
  assert.equal(reserve(s.store, { roots: [other], owner: 'host', sessionId: 'unrelated' }).state, 'reserved');
  fs.mkdirSync(s.root);
  for (const root of [s.root, payloadPath, containerPath]) assert.throws(() => reserve(s.store, { roots: [root], owner: 'host', sessionId: 'blocked' }), /Cleanup/);
  fs.renameSync(containerPath, path.join(s.base, 'moved-container')); fs.mkdirSync(containerPath);
  assert.throws(() => reserve(s.store, { roots: [other], owner: 'host', sessionId: 'substituted' }), /Cleanup/);
});
