import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { Store } from '../lib/store.mjs';
import { acquireCleanup, inactive, releaseCleanup, reserve, transition } from '../lib/admission.mjs';
import { child, fixture } from './helpers.mjs';

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
