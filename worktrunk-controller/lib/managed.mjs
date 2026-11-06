import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { digest, text } from './data.mjs';
import { fileIdentity, localPath } from './paths.mjs';
import { reserve, transition } from './admission.mjs';
import { producerRoots } from './artifacts.mjs';
import { verifyNativeHost } from './native-host.mjs';

export async function runManaged(config, store, { root, projectId, sessionId, program, args }) {
  if (process.platform !== 'win32' || !config.nativeHost) throw new Error('Qualified native Windows lifetime host required');
  root = localPath(root); program = localPath(program); text(sessionId, 'sessionId');
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Invalid managed command arguments');
  const host = verifyNativeHost(config);
  const claim = reserve(store, { roots: producerRoots(config, store, projectId, root), sessionId, owner: config.host.id });
  transition(store, claim.token, 'reserved', 'starting');
  let phase = 'starting', result;
  const child = spawn(host.path, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
  child.stdin.on('error', () => {});
  const finished = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  // Attach immediately: an early spawn failure must not become an unhandled rejection.
  finished.catch(() => {});
  try {
    child.stdin.write(`${JSON.stringify({ version: 1, token: claim.token, cwd: root, program, args })}\n`);
    const lines = createInterface({ input: child.stdout });
    for await (const line of lines) {
      if (line.length > 65536) throw new Error('Oversized native host response');
      const message = JSON.parse(line);
      if (message.version !== 1 || message.evidence?.helperPid !== child.pid || message.evidence?.launchToken !== claim.token) throw new Error('Native lifetime response mismatch');
      if (message.type === 'contained' && phase === 'starting' && message.evidence.activeProcesses === null) {
        if (digest(producerRoots(config, store, projectId, root)) !== digest(claim.roots.map(root => root.path)) || claim.roots.some(root => digest(fileIdentity(root.path)) !== digest(root.incarnation))) throw new Error('Managed root incarnation changed before launch');
        if (digest(host) !== digest(verifyNativeHost(config))) throw new Error('Native host executable changed before launch');
        transition(store, claim.token, phase, 'running', message.evidence);
        phase = 'running';
        child.stdin.write(`ack ${claim.token}\n`);
      } else if (message.type === 'ended' && phase === 'running') {
        if (digest(host) !== digest(verifyNativeHost(config))) throw new Error('Native host executable changed during launch');
        transition(store, claim.token, phase, 'ended', message.evidence);
        phase = 'ended'; result = { token: claim.token, exitCode: message.exitCode };
      } else throw new Error('Invalid native lifetime protocol transition');
    }
    const exit = await finished;
    if (phase !== 'ended' || exit.code !== 0) throw new Error('Native lifetime completion unavailable');
    return result;
  } catch (error) {
    try { if (phase !== 'ended') transition(store, claim.token, phase, 'unresolved'); }
    finally { child.kill(); await finished.catch(() => {}); }
    throw error;
  } finally { child.stdin.end(); }
}
