import { Store } from '../../lib/store.mjs';
import { runManaged } from '../../lib/managed.mjs';

const [state, config, request] = process.argv.slice(2);
const store = new Store(state);
try { await runManaged(JSON.parse(config), store, JSON.parse(request)); }
finally { store.close(); }
