import { Store } from '../../lib/store.mjs';
import { runManaged } from '../../lib/managed.mjs';
import { runJournaledCommand } from '../../lib/native-host.mjs';

const [state, config, request, mode] = process.argv.slice(2);
const store = new Store(state);
try {
  if (mode === 'journaled') await runJournaledCommand(JSON.parse(config), store, JSON.parse(request),
    (tx, launch) => tx.put('action_command', 'fixture', { version: 1, launch }));
  else await runManaged(JSON.parse(config), store, JSON.parse(request));
}
finally { store.close(); }
