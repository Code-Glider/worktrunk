import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { digest } from './data.mjs';
import { fileIdentity, localPath } from './paths.mjs';

export function verifyNativeHost(config) {
  if (process.platform !== 'win32' || config.nativeHost?.version !== 1) throw new Error('Qualified native Windows lifetime host required');
  const path = localPath(config.nativeHost.path), incarnation = fileIdentity(path);
  const hash = () => createHash('sha256').update(fs.readFileSync(path)).digest('hex');
  if (hash() !== config.nativeHost.sha256) throw new Error('Native host executable hash changed');
  const version = spawnSync(path, ['--version'], { windowsHide: true, encoding: 'utf8', timeout: config.limits.timeoutMs });
  if (version.status !== 0 || version.stdout.trim() !== 'wt-controller-host 1') throw new Error('Unsupported native host protocol');
  if (digest(incarnation) !== digest(fileIdentity(path)) || hash() !== config.nativeHost.sha256) throw new Error('Native host executable changed during verification');
  return { path, incarnation, sha256: config.nativeHost.sha256, version: 1 };
}

function completionPath(config, { stateDir, stateIdentity, evidence }) {
  if (stateDir !== localPath(config.stateDir) || digest(fileIdentity(stateDir)) !== digest(stateIdentity) ||
      !/^[a-f0-9-]{36}$/.test(evidence.launchToken)) throw new Error('Native command state boundary changed');
  return localPath(path.join(stateDir, `${evidence.launchToken}.native-completion`), { missing: true });
}

export function readCommandCompletion(config, launch) {
  const filename = completionPath(config, launch);
  let fd;
  try { fd = fs.openSync(filename, 'r'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const stat = fs.fstatSync(fd);
    const bytes = Buffer.alloc(1024);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size >= bytes.length) throw new Error('Invalid native completion file');
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
    if (length !== stat.size || message.version !== 1 || message.type !== 'ended' ||
        digest(message.evidence) !== digest({ ...launch.evidence, activeProcesses: 1 }) || !Number.isSafeInteger(message.exitCode)) throw new Error('Native command completion does not match authorization');
    return message;
  } finally { fs.closeSync(fd); }
}

// After the authorization transaction commits, only a native receipt proves the job drained.
export async function runJournaledCommand(config, store, { root, program, args, env }, authorize) {
  const host = verifyNativeHost(config), token = randomUUID();
  const stateDir = localPath(config.stateDir), stateIdentity = fileIdentity(stateDir);
  const request = { version: 1, token, cwd: localPath(root), program: localPath(program), args,
    completionFile: completionPath(config, { stateDir, stateIdentity, evidence: { launchToken: token } }) };
  const child = spawn(host.path, [], { detached: true, windowsHide: true, env, stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdin.on('error', () => {});
  const lines = createInterface({ input: child.stdout });
  child.on('error', () => lines.close());
  const deadline = setTimeout(() => lines.close(), config.limits.timeoutMs);
  let launch;
  try {
    child.stdin.write(`${JSON.stringify(request)}\n`);
    for await (const line of lines) {
      if (launch) break;
      if (line.length > 65536) throw new Error('Oversized native host response');
      const message = JSON.parse(line);
      const evidence = { kind: 'windows_job', launchToken: token, helperPid: child.pid, activeProcesses: null };
      if (message.version !== 1 || message.type !== 'contained' || digest(message.evidence) !== digest(evidence)) throw new Error('Native command containment mismatch');
      const admitted = { stateDir, stateIdentity, evidence };
      completionPath(config, admitted);
      if (digest(host) !== digest(verifyNativeHost(config))) throw new Error('Native host executable changed before authorization');
      store.transaction(tx => authorize(tx, admitted));
      launch = admitted;
      deadline.refresh();
      child.stdin.end(`ack ${token}\n`);
    }
    const completion = launch && readCommandCompletion(config, launch);
    if (!completion) throw new Error('Native command completion unavailable');
    return completion;
  } finally {
    clearTimeout(deadline);
    lines.close();
    if (!launch) child.kill();
    child.stdin.destroy();
    child.stdout.destroy();
    child.unref();
  }
}
