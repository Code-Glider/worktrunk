import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../lib/config.mjs';
import { Store } from '../../lib/store.mjs';
import { quarantineArtifact, restore, reconcile } from '../../lib/actions.mjs';

const [mode, filename, id, checkpoint, gate] = process.argv.slice(2);
const config = loadConfig(filename), store = new Store(config.stateDir);
function pause(point) {
  if (checkpoint !== point) return;
  fs.writeSync(1, `${point}\n`);
  while (!gate || !fs.existsSync(gate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
}
const mkdir = fs.mkdirSync, rename = fs.renameSync;
fs.mkdirSync = (target, ...args) => {
  if (target === config.quarantineDir) pause('before-container');
  const result = mkdir(target, ...args);
  if (path.dirname(target) === config.quarantineDir) pause('after-container');
  return result;
};
fs.renameSync = (...args) => { pause('before-rename'); const result = rename(...args); pause('after-rename'); return result; };
try {
  if (checkpoint === 'starting') fs.writeSync(1, 'starting\n');
  const result = mode === 'apply' ? quarantineArtifact(config, store, id) : mode === 'restore' ? restore(config, store, id) : reconcile(config, store, id);
  fs.writeSync(1, `${result.phase}\n`);
} catch (error) { fs.writeSync(2, `${error.message}\n`); process.exitCode = 1; }
finally { store.close(); }
