import fs from 'node:fs';
import { Store } from '../../lib/store.mjs';
import { enroll } from '../../lib/identity.mjs';
import { ingest } from '../../lib/events.mjs';
import { acquireCleanup, reserve } from '../../lib/admission.mjs';

const [mode, directory, root, gitDir] = process.argv.slice(2);
const store = new Store(directory);
if (mode.startsWith('claim-')) {
  try {
    const record = mode === 'claim-cleanup' ? acquireCleanup(store, { roots: [root], owner: 'test' }) : reserve(store, { roots: [root], owner: 'test', sessionId: 's' });
    fs.writeSync(1, `claimed ${record.token}\n`);
    if (mode === 'claim-interrupt') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
  } catch (error) { fs.writeSync(1, `blocked ${error.message}\n`); }
} else if (mode === 'events') {
  const config = { eventSources: [{ id: 'host', instance: 'host-1', role: 'host', projects: ['p'], authority: null }] };
  for (let i = 0; i < 20; i++) ingest(config, store, 'host', { version: 1, eventId: `${root}-${i}`, project: 'p', type: 'working', sessionId: root });
  console.log('20 events committed');
} else if (mode === 'increment') {
  for (let i = 0; i < 40; i++) store.transaction(tx => tx.put('counter', 'one', { version: 1, n: (tx.get('counter', 'one')?.value.n ?? 0) + 1 }));
  console.log('40 committed');
} else if (mode === 'interrupt') {
  store.transaction(tx => {
    tx.put('counter', 'one', { version: 1, n: 999 });
    fs.writeSync(1, 'uncommitted\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
  });
} else if (mode === 'enroll-interrupt') {
  const sync = fs.fsyncSync;
  fs.fsyncSync = fd => {
    sync(fd);
    fs.writeSync(1, 'marker-flushed\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
  };
  enroll(store, root, gitDir);
} else throw new Error('Unknown worker operation');
store.close();
