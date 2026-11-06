import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

export const controllerRoot = fileURLToPath(new URL('../', import.meta.url));

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
