import fs from 'node:fs';
import { Store } from '../../lib/store.mjs';
import { enroll } from '../../lib/identity.mjs';

const [mode, directory, root, gitDir] = process.argv.slice(2);
const store = new Store(directory);
if (mode === 'increment') {
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
