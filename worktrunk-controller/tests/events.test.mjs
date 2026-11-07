import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { ingest, sourceCoverage } from '../lib/events.mjs';
import { child, fixture } from './helpers.mjs';

export const sources = [
  { id: 'host', instance: 'host-1', role: 'host', projects: ['p', 'q'], authority: null },
  { id: 'tasks', instance: 'tasks-1', role: 'task', projects: ['p', 'q'], authority: 'tracker' },
];

test('source/event replay is atomic, restart-safe and rejects conflicting authority or sequence', t => {
  const directory = path.join(fixture(t), 'state');
  let store = new Store(directory);
  const config = { eventSources: sources };
  const payload = { version: 1, eventId: 'one', type: 'waiting', project: 'p', sessionId: 's', sequence: 1 };
  assert.equal(ingest(config, store, 'host', payload, 1000).replay, false);
  store.close(); store = new Store(directory);
  try {
    assert.equal(ingest(config, store, 'host', payload, 2000).replay, true);
    assert.equal(store.list('event').length, 1);
    assert.equal(store.list('event')[0].value.observedAt, 1000);
    assert.throws(() => ingest(config, store, 'host', { ...payload, type: 'working' }), /Conflicting event replay/);
    assert.throws(() => ingest(config, store, 'host', { ...payload, eventId: 'two' }), /Conflicting source sequence/);
    assert.throws(() => ingest(config, store, 'host', { ...payload, type: 'attempt_accepted' }), /outside source authority/);
    assert.throws(() => ingest({ eventSources: [{ ...sources[0], projects: ['p'] }] }, store, 'host', payload), /binding changed/);
    assert.throws(() => ingest(config, store, 'host', { ...payload, rawPrompt: 'never persist' }), /Unsupported/);
    assert.throws(() => ingest(config, store, 'host', { ...payload, version: 2 }), /Unsupported/);
  } finally { store.close(); }
});

test('independent checkpoints detect silent gaps; absent sequences remain unmeasured', t => {
  const store = new Store(path.join(fixture(t), 'state'));
  try {
    const config = { eventSources: sources };
    for (const sequence of [3, 1]) ingest(config, store, 'host', { version: 1, eventId: `${sequence}`, project: 'p', type: 'waiting', sequence });
    ingest(config, store, 'host', { version: 1, eventId: 'check', project: 'p', type: 'checkpoint', fromSequence: 1, throughSequence: 3 });
    let coverage = sourceCoverage(sources[0], store.list('event').map(row => row.value.event));
    assert.deepEqual(coverage.checkpoints[0].missing, [[2, 2]]);
    assert.equal(coverage.status, 'partial_unmeasured');
    ingest(config, store, 'host', { version: 1, eventId: '2', project: 'p', type: 'waiting', sequence: 2 });
    coverage = sourceCoverage(sources[0], store.list('event').map(row => row.value.event));
    assert.equal(coverage.checkpoints[0].status, 'checkpoint_complete');
    assert.equal(coverage.status, 'partial_unmeasured');
    assert.equal(sourceCoverage(sources[1], []).status, 'partial_unmeasured');
  } finally { store.close(); }
});

test('two event producers keep every acknowledged event', async t => {
  const directory = path.join(fixture(t), 'state');
  const results = await Promise.all([child('events', directory, 'a').done, child('events', directory, 'b').done]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const store = new Store(directory);
  try { assert.equal(store.list('event').length, 40); } finally { store.close(); }
});

test('failed event commit rolls back source binding and emits no acknowledgment', t => {
  const store = new Store(path.join(fixture(t), 'state'));
  try {
    store.transaction(tx => tx.put('counter', 'prior', { version: 1, n: 7 }));
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const pages = store.db.prepare('PRAGMA page_count').get().page_count;
    store.db.exec(`PRAGMA max_page_count=${pages}`);
    assert.throws(() => ingest({ eventSources: sources }, store, 'host', { version: 1, eventId: 'x'.repeat(40000), project: 'p', type: 'waiting' }), /full/);
    assert.equal(store.list('event').length, 0);
    assert.equal(store.list('event_source').length, 0);
    assert.equal(store.get('counter', 'prior').value.n, 7);
  } finally { store.close(); }
});
