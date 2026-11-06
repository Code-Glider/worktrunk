import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { digest } from './data.mjs';
import { fileIdentity, localPath } from './paths.mjs';

export function isolatedEnvironment(scratch, inherited = process.env) {
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => !/^(GIT_|WORKTRUNK_|RUST_LOG$)/i.test(key)));
  const emptyGit = path.join(scratch, 'gitconfig');
  const emptyWt = path.join(scratch, 'wt.toml');
  fs.writeFileSync(emptyGit, '', { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(emptyWt, '[list]\nfull = false\nsummary = false\njson-schema = 2\n', { flag: 'wx', mode: 0o600 });
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyGit, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', WORKTRUNK_CONFIG_PATH: emptyWt, WORKTRUNK_SYSTEM_CONFIG_PATH: emptyWt, WORKTRUNK_PROJECT_CONFIG_PATH: '', WORKTRUNK_APPROVALS_PATH: path.join(scratch, 'approvals.toml'), WORKTRUNK_CONTROLLER_SCRATCH: scratch, NO_COLOR: '1' };
}

export function invocation(config, root, fn) {
  root = localPath(root);
  const parent = localPath(path.join(config.stateDir, 'invocations'), { missing: true });
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  localPath(parent);
  const scratch = fs.mkdtempSync(path.join(parent, 'scan-'));
  const identity = fileIdentity(scratch);
  let completed = false;
  let probeFailed = false;
  try {
    const env = isolatedEnvironment(scratch);
    function run(program, args, cwd = root) {
      const output = spawnSync(program, args, { cwd: localPath(cwd), env, windowsHide: true, timeout: config.limits.timeoutMs, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      if (output.error || output.status !== 0) {
        probeFailed = true;
        throw new Error(`Probe failed: ${path.basename(program)} (${output.error?.code ?? output.status ?? output.signal})`);
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(output.stdout);
    }
    const git = (args, cwd = root) => run('git', ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${path.join(scratch, 'hooks-disabled')}`, ...args], cwd);
    const wt = args => {
      const filename = localPath(config.worktrunk.path);
      const hash = () => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
      const before = fileIdentity(filename);
      if (hash() !== config.worktrunk.sha256) throw new Error('Worktrunk executable hash changed');
      const [name, version, ...extra] = run(filename, ['--version']).trim().split(/\s+/);
      if (name !== 'wt' || extra.length || version?.replace(/^v/, '').split(/[-+]/)[0] !== config.worktrunk.version) throw new Error('Worktrunk executable version changed');
      const output = run(filename, args);
      if (digest(before) !== digest(fileIdentity(filename)) || hash() !== config.worktrunk.sha256) throw new Error('Worktrunk executable changed during observation');
      return output;
    };
    const result = fn({ git, wt, scratch });
    if (result && typeof result.then === 'function') throw new Error('Invocation callback must be synchronous');
    completed = true;
    return result;
  } finally {
    // Failed/expired probes retain their private scratch for explicit recovery.
    if (completed && !probeFailed && digest(identity) === digest(fileIdentity(scratch))) fs.rmSync(localPath(scratch), { recursive: true });
  }
}

export function worktreeInventory(git) {
  const records = [];
  let current;
  for (const field of git(['worktree', 'list', '--porcelain', '-z']).split('\0')) {
    if (!field) { current = null; continue; }
    const space = field.indexOf(' ');
    const key = space < 0 ? field : field.slice(0, space);
    const value = space < 0 ? true : field.slice(space + 1);
    if (key === 'worktree') { current = { path: value }; records.push(current); }
    else if (!current) throw new Error('Malformed Git worktree inventory');
    else current[key] = value;
  }
  if (!records.length) throw new Error('Empty Git worktree inventory');
  return records;
}

export function refVector(git) {
  const refs = {};
  for (const line of git(['for-each-ref', '--format=%(refname) %(objectname) %(symref)', 'refs/heads/', 'refs/remotes/']).trim().split('\n').filter(Boolean)) {
    const [name, sha, symref] = line.trim().split(' ');
    if (symref) continue;
    if (!/^refs\/(heads|remotes)\//.test(name) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) throw new Error('Malformed ref inventory');
    refs[name] = sha;
  }
  return refs;
}
