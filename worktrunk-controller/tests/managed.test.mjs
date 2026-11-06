import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Store } from '../lib/store.mjs';
import { acquireCleanup, inactive } from '../lib/admission.mjs';
import { runManaged } from '../lib/managed.mjs';
import { controller, fixture, nativeWorktrunk } from './helpers.mjs';

const host = nativeWorktrunk('wt-controller-host');
const binary = process.platform === 'win32' ? nativeWorktrunk() : null;
function setup(t) {
  let store;
  const root = fixture(t, () => store?.close()), state = path.join(root, 'state');
  store = new Store(state);
  const config = { nativeHost: { path: host, sha256: createHash('sha256').update(fs.readFileSync(host)).digest('hex'), version: 1 }, host: { id: 'test-host' }, limits: { timeoutMs: 5000 } };
  return { root, state, store, config };
}
async function until(predicate) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await setTimeout(20); }
  throw new Error('Fixture condition was not observed');
}
function suspend(pid, resume = false) {
  const script = fileURLToPath(new URL('./fixtures/suspend.ps1', import.meta.url));
  // Cold PowerShell/Add-Type startup competes with parallel native builds in CI.
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-FixtureProcessId', String(pid), ...(resume ? ['-Resume'] : [])], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
}

test('native host refuses unsupported lifetime containment without starting an agent', { skip: process.platform === 'win32' }, t => {
  const s = setup(t), sentinel = path.join(s.root, 'never');
  const result = spawnSync(host, [], { input: JSON.stringify({ version: 1, token: 'a'.repeat(36), cwd: s.root, program: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(sentinel)},'bad')`] }) + '\n', encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /not qualified/); assert.equal(fs.existsSync(sentinel), false);
});

test('native job retains detached and OS-suspended descendants until completion', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const s = setup(t), ready = path.join(s.root, 'ready'), gate = path.join(s.root, 'gate'), done = path.join(s.root, 'done'), heartbeat = path.join(s.root, 'heartbeat');
  const descendant = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));let n=0;const timer=setInterval(()=>{fs.writeFileSync(${JSON.stringify(heartbeat)},String(++n));if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(timer);fs.writeFileSync(${JSON.stringify(done)},'finished');}},20);`;
  const parent = `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:'ignore'});c.unref();`;
  const running = runManaged(s.config, s.store, { root: s.root, sessionId: 'one', program: process.execPath, args: ['-e', parent] });
  running.catch(() => {});
  try {
    await until(() => fs.existsSync(ready) && fs.existsSync(heartbeat));
    assert.equal(s.store.list('claim')[0].value.state, 'running');
    assert.equal(inactive(s.store, s.root), false);
    assert.throws(() => acquireCleanup(s.store, { owner: 'cleanup', roots: [s.root] }), /owner/);
    assert.equal(fs.existsSync(done), false);
    const pid = Number(fs.readFileSync(ready, 'utf8'));
    try {
      suspend(pid);
      const stopped = fs.readFileSync(heartbeat, 'utf8');
      await setTimeout(150);
      assert.equal(fs.readFileSync(heartbeat, 'utf8'), stopped);
      assert.equal(inactive(s.store, s.root), false);
      assert.throws(() => acquireCleanup(s.store, { owner: 'cleanup', roots: [s.root] }), /owner/);
    } finally { suspend(pid, true); }
  } finally { fs.writeFileSync(gate, 'finish'); await running; }
  const result = await running;
  assert.equal(result.exitCode, 0); assert.equal(fs.readFileSync(done, 'utf8'), 'finished');
  assert.equal(s.store.list('claim')[0].value.state, 'ended'); assert.equal(inactive(s.store, s.root), true);
});

test('failed persistence and an existing cleanup claim prevent native agent startup', { skip: process.platform !== 'win32' }, async t => {
  const s = setup(t), sentinel = path.join(s.root, 'never');
  const request = { root: s.root, sessionId: 'one', program: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(sentinel)},'bad')`] };
  s.store.db.exec("CREATE TRIGGER fail_claim BEFORE INSERT ON records WHEN NEW.kind='claim' BEGIN SELECT RAISE(ABORT,'injected persistence failure'); END;");
  await assert.rejects(runManaged(s.config, s.store, request), /persistence failure/);
  assert.equal(fs.existsSync(sentinel), false); assert.equal(s.store.list('claim').length, 0);
  s.store.db.exec('DROP TRIGGER fail_claim');
  acquireCleanup(s.store, { roots: [s.root], owner: 'test' });
  await assert.rejects(runManaged(s.config, s.store, request), /Cleanup/);
  assert.equal(fs.existsSync(sentinel), false);
});

test('failed running-state commit prevents acknowledgement and leaves startup protected', { skip: process.platform !== 'win32' }, async t => {
  const s = setup(t), sentinel = path.join(s.root, 'never');
  s.store.db.exec("CREATE TRIGGER fail_running BEFORE INSERT ON records WHEN NEW.kind='claim' AND json_extract(NEW.body,'$.state')='running' BEGIN SELECT RAISE(ABORT,'injected running commit failure'); END;");
  await assert.rejects(runManaged(s.config, s.store, { root: s.root, sessionId: 'one', program: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(sentinel)},'bad')`] }), /running commit failure/);
  assert.equal(fs.existsSync(sentinel), false);
  assert.equal(s.store.list('claim')[0].value.state, 'unresolved');
  assert.equal(inactive(s.store, s.root), false);
});

test('failed completion commit never releases a finished producer claim', { skip: process.platform !== 'win32' }, async t => {
  const s = setup(t);
  s.store.db.exec("CREATE TRIGGER fail_ended BEFORE INSERT ON records WHEN NEW.kind='claim' AND json_extract(NEW.body,'$.state')='ended' BEGIN SELECT RAISE(ABORT,'injected completion commit failure'); END;");
  await assert.rejects(runManaged(s.config, s.store, { root: s.root, sessionId: 'one', program: process.execPath, args: ['-e', ''] }), /completion commit failure/);
  assert.equal(s.store.list('claim')[0].value.state, 'unresolved');
  assert.equal(inactive(s.store, s.root), false);
});

test('helper failure kills its contained agent but never releases unknown ownership', { skip: process.platform !== 'win32' }, async t => {
  const s = setup(t), ready = path.join(s.root, 'ready'), heartbeat = path.join(s.root, 'heartbeat');
  const agent = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));let n=0;setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeat)},String(++n)),20);`;
  const running = runManaged(s.config, s.store, { root: s.root, sessionId: 'one', program: process.execPath, args: ['-e', agent] });
  running.catch(() => {});
  let helper;
  try {
    await until(() => fs.existsSync(heartbeat));
    helper = s.store.list('claim')[0].value.evidence.helperPid;
    process.kill(helper, 'SIGKILL');
    await assert.rejects(running, /completion unavailable/);
    const stopped = fs.readFileSync(heartbeat, 'utf8'); await setTimeout(150);
    assert.equal(fs.readFileSync(heartbeat, 'utf8'), stopped);
    assert.equal(s.store.list('claim')[0].value.state, 'unresolved');
    assert.throws(() => acquireCleanup(s.store, { roots: [s.root], owner: 'cleanup' }), /owner/);
  } finally {
    helper ??= s.store.list('claim')[0]?.value.evidence?.helperPid;
    if (helper) { try { process.kill(helper, 'SIGKILL'); } catch {} }
    await running.catch(() => {});
  }
});

test('controller crash leaves a running reservation protected across restart', { skip: process.platform !== 'win32' }, async t => {
  const s = setup(t), ready = path.join(s.root, 'ready');
  const agent = `require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},20);`;
  const worker = fileURLToPath(new URL('./fixtures/managed-worker.mjs', import.meta.url));
  const parent = spawn(process.execPath, [worker, s.state, JSON.stringify(s.config), JSON.stringify({ root: s.root, sessionId: 'one', program: process.execPath, args: ['-e', agent] })], { stdio: 'ignore', windowsHide: true });
  const exited = once(parent, 'exit');
  try {
    await until(() => fs.existsSync(ready));
    parent.kill('SIGKILL'); await exited;
    const reopened = new Store(s.state);
    try {
      assert.equal(reopened.list('claim')[0].value.state, 'running');
      assert.throws(() => acquireCleanup(reopened, { roots: [s.root], owner: 'cleanup' }), /owner/);
    } finally { reopened.close(); }
  } finally {
    parent.kill('SIGKILL'); await exited;
    const helper = s.store.list('claim')[0]?.value.evidence?.helperPid;
    if (helper) { try { process.kill(helper, 'SIGKILL'); } catch {} }
  }
  assert.equal(inactive(s.store, s.root), false);
});

test('managed CLI requires enrollment and a pinned host, preserves arguments and exit status', { skip: process.platform !== 'win32' }, t => {
  const s = controller(t, binary), cli = fileURLToPath(new URL('../bin/controller.mjs', import.meta.url));
  const value = JSON.parse(fs.readFileSync(s.filename, 'utf8'));
  value.nativeHost = { path: host, version: 1, sha256: createHash('sha256').update(fs.readFileSync(host)).digest('hex') };
  fs.writeFileSync(s.filename, JSON.stringify(value));
  const args = ['--config', s.filename, '--project', 'myproject', '--path', s.root, '--format', 'json'];
  const run = (command, extra = []) => spawnSync(process.execPath, [cli, command, ...args, ...extra], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const sentinel = path.join(s.root, 'sentinel');
  const command = ['--session', 'explicit-session', '--program', process.execPath, '--', '-e', `require('fs').writeFileSync(${JSON.stringify(sentinel)},process.argv[1]);console.log('{"type":"ended"}');process.exitCode=7;`, '--', '--literal argument א'];
  const unenrolled = run('run', command);
  assert.equal(unenrolled.status, 1); assert.match(unenrolled.stderr, /matching enrollment/); assert.equal(fs.existsSync(sentinel), false);
  assert.equal(run('enroll').status, 0);
  value.nativeHost.sha256 = '0'.repeat(64); fs.writeFileSync(s.filename, JSON.stringify(value));
  const unpinned = run('run', command); assert.equal(unpinned.status, 1); assert.match(unpinned.stderr, /hash changed/);
  assert.equal(fs.existsSync(sentinel), false);
  const store = new Store(s.state);
  try { assert.equal(store.list('claim').length, 0); } finally { store.close(); }
  value.nativeHost.sha256 = createHash('sha256').update(fs.readFileSync(host)).digest('hex'); fs.writeFileSync(s.filename, JSON.stringify(value));
  const completed = run('run', command);
  assert.equal(completed.status, 7, completed.stderr);
  assert.match(completed.stderr, /"type":"ended"/);
  assert.equal(JSON.parse(completed.stdout).exitCode, 7);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), '--literal argument א');
});
