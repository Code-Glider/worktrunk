import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../lib/store.mjs';
import { child, fixture } from './helpers.mjs';

function storage(t) {
  let store;
  const state = path.join(fixture(t, () => store?.close()), 'state');
  return { state, open() { store = new Store(state); return store; } };
}

test('two independent writers never lose acknowledged commits', async t => {
  const storage_ = storage(t);
  const { state } = storage_;
  const results = await Promise.all([child('increment', state).done, child('increment', state).done]);
  for (const result of results) { assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /40 committed/); }
  const store = storage_.open();
  assert.equal(store.get('counter', 'one').value.n, 80);
});

test('killed transaction rolls back while preceding acknowledged commit survives', async t => {
  const storage_ = storage(t);
  const { state } = storage_;
  const initial = new Store(state);
  initial.transaction(tx => tx.put('counter', 'one', { version: 1, n: 7 }));
  initial.close();
  const run = child('interrupt', state);
  await Promise.race([once(run.process.stdout, 'data'), run.done.then(result => { throw new Error(`Worker exited before transaction: ${result.stderr}`); })]);
  run.process.kill('SIGKILL');
  await run.done;
  const store = storage_.open();
  assert.equal(store.get('counter', 'one').value.n, 7);
});

test('disk-full aborts mutation and preserves prior evidence', t => {
  const store = storage(t).open();
  store.transaction(tx => tx.put('counter', 'one', { version: 1, n: 7 }));
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const pages = store.db.prepare('PRAGMA page_count').get().page_count;
  store.db.exec(`PRAGMA max_page_count=${pages}`);
  assert.throws(() => store.transaction(tx => tx.put('counter', 'one', { version: 1, data: 'x'.repeat(2_000_000) })), /full/);
  assert.equal(store.get('counter', 'one').value.n, 7);
});

test('unsupported and corrupt databases are never replaced', t => {
  const root = fixture(t);
  const state = path.join(root, 'future'); fs.mkdirSync(state);
  const db = new DatabaseSync(path.join(state, 'controller.sqlite'));
  db.exec('PRAGMA user_version=99'); db.close();
  assert.throws(() => new Store(state), /Unsupported state schema/);
  const corrupt = path.join(root, 'corrupt'); fs.mkdirSync(corrupt);
  const filename = path.join(corrupt, 'controller.sqlite');
  fs.writeFileSync(filename, 'precious damaged evidence');
  const before = fs.readFileSync(filename);
  assert.throws(() => new Store(corrupt));
  assert.deepEqual(fs.readFileSync(filename), before);
});

test('records require a synchronous transaction and supported schema', t => {
  const store = storage(t).open();
  assert.throws(() => store.put('counter', 'one', { version: 1 }), /transaction/);
  assert.throws(() => store.transaction(async () => {}), /synchronous/);
  assert.throws(() => store.transaction(tx => tx.put('counter', 'one', { version: 2 })), /record schema/);
  store.transaction(tx => tx.put('counter', 'one', { version: 1, n: 2 }));
  store.db.prepare('UPDATE records SET body=?').run('{"version":99}');
  assert.throws(() => store.transaction(tx => tx.put('counter', 'one', { version: 1, n: 3 })), /record schema/);
  assert.equal(store.db.prepare('SELECT body FROM records').get().body, '{"version":99}');
});
