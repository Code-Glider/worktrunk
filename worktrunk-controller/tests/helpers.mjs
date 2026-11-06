import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadConfig } from '../lib/config.mjs';

export const controllerRoot = fileURLToPath(new URL('../', import.meta.url));

export function nativeWorktrunk() {
  const messages = execFileSync('cargo', ['build', '--locked', '--bin', 'wt', '--message-format=json'], { cwd: path.dirname(controllerRoot), encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  const artifact = messages.split('\n').filter(Boolean).map(line => JSON.parse(line)).findLast(message => message.reason === 'compiler-artifact' && message.target.name === 'wt' && message.executable);
  assert.ok(artifact, 'Cargo must report the actual executable');
  return artifact.executable;
}

export function controller(t, binary) {
  const repo = repository(t);
  const registry = path.join(repo.base, 'projects.json');
  fs.writeFileSync(registry, JSON.stringify({ version: 1, projects: [{ id: 'myproject', root: repo.root }] }));
  const value = { version: 1, host: { id: 'test-host', platform: process.platform }, registry, stateDir: repo.state, quarantineDir: path.join(repo.base, 'quarantine'), worktrunk: { path: binary, sha256: createHash('sha256').update(fs.readFileSync(binary)).digest('hex'), version: '0.81.0', schema: 2 }, policy: { generation: 1, minAgeMs: 100, retentionMs: 1000, allowApply: false, deleteBranches: false }, limits: { timeoutMs: 10000, maxFiles: 1000, maxBytes: 10000000 }, artifactRoots: [] };
  const filename = path.join(repo.base, 'config.json');
  fs.writeFileSync(filename, JSON.stringify(value));
  return { ...repo, filename, config: loadConfig(filename) };
}

export function child(mode, state, ...args) {
  const worker = fileURLToPath(new URL('./fixtures/state-worker.mjs', import.meta.url));
  const process_ = spawn(process.execPath, [worker, mode, state, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  process_.stdout.on('data', chunk => { stdout += chunk; });
  process_.stderr.on('data', chunk => { stderr += chunk; });
  return { process: process_, done: once(process_, 'exit').then(([code, signal]) => ({ code, signal, stdout, stderr })) };
}

export function fixture(t, dispose = () => {}) {
  const base = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, 'wt-controller-test-'));
  t.after(() => {
    dispose();
    assert.equal(path.dirname(root), base);
    assert.ok(path.basename(root).startsWith('wt-controller-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

export function git(root, ...args) {
  const config = path.join(path.dirname(root), 'empty-gitconfig');
  fs.writeFileSync(config, '');
  return execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, GIT_OPTIONAL_LOCKS: '0', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function repository(t) {
  const base = fixture(t);
  const root = path.join(base, 'myproject');
  fs.mkdirSync(root);
  git(root, 'init', '-b', 'main');
  git(root, 'commit', '--allow-empty', '-m', 'Initial');
  return { base, root, gitDir: path.join(root, '.git'), state: path.join(base, 'state') };
}
