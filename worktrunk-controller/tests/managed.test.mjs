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
import { acquireCleanup, inactive, releaseCleanup, reserve, transition } from '../lib/admission.mjs';
import { enrollArtifact } from '../lib/artifacts.mjs';
import { loadConfig } from '../lib/config.mjs';
import { syncGitHubIssue } from '../lib/events.mjs';
import { enroll } from '../lib/identity.mjs';
import { runManaged } from '../lib/managed.mjs';
import { scanProject } from '../lib/observe.mjs';
import { report } from '../lib/report.mjs';
import { controller, fixture, git, nativeWorktrunk } from './helpers.mjs';

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

test('native command spawn failure leaves ownership unresolved', { skip: process.platform !== 'win32' }, async t => {
  const s = setup(t), program = path.join(s.root, 'invalid.exe');
  fs.writeFileSync(program, 'not an executable');
  await assert.rejects(runManaged(s.config, s.store, { root: s.root, sessionId: 'invalid-program', program, args: [] }), /completion unavailable/);
  assert.equal(s.store.list('claim')[0].value.state, 'unresolved');
  assert.equal(inactive(s.store, s.root), false);
});

test('native launch reserves a shared artifact root before either project starts writing', { skip: process.platform !== 'win32' }, async t => {
  const s = setup(t), root = path.join(s.root, 'checkout'), cache = path.join(s.root, 'shared-cache');
  fs.mkdirSync(root); fs.mkdirSync(cache);
  s.config.artifactRoots = [{ id: 'shared', path: cache, owner: s.config.host.id, projects: ['one', 'two'], managedOnly: true, retentionMs: 1000, classes: [] }];
  const ready = path.join(cache, 'ready'), gate = path.join(cache, 'gate');
  const request = { root, projectId: 'one', sessionId: 'one', program: process.execPath, args: ['-e', `const fs=require('fs');fs.writeFileSync(${JSON.stringify(ready)},'writing');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)}))clearInterval(timer);},20);`] };
  await assert.rejects(runManaged(s.config, s.store, request), /enrollment/);
  assert.equal(fs.existsSync(ready), false);
  enrollArtifact(s.config, s.store, 'shared');
  const cleanup = acquireCleanup(s.store, { owner: 'cleanup', roots: [cache] });
  await assert.rejects(runManaged(s.config, s.store, { ...request, projectId: 'two' }), /Cleanup/);
  assert.equal(fs.existsSync(ready), false); assert.equal(s.store.list('claim').length, 1);
  releaseCleanup(s.store, cleanup.token);
  const running = runManaged(s.config, s.store, request); running.catch(() => {});
  try {
    await until(() => fs.existsSync(ready));
    const admitted = s.store.list('claim').find(row => row.value.kind === 'producer').value;
    assert.deepEqual(admitted.roots.map(root => root.path), [root, cache]);
    assert.throws(() => acquireCleanup(s.store, { owner: 'cleanup', roots: [cache] }), /owner/);
    assert.equal(inactive(s.store, cache), false);
  } finally { fs.writeFileSync(gate, 'finished'); await running; }
  assert.equal(inactive(s.store, cache), true);
});

test('artifact recreation after reservation prevents native launch acknowledgement', { skip: process.platform !== 'win32' }, async t => {
  const s = setup(t), root = path.join(s.root, 'checkout'), cache = path.join(s.root, 'cache'), sentinel = path.join(root, 'never');
  fs.mkdirSync(root); fs.mkdirSync(cache);
  s.config.artifactRoots = [{ id: 'cache', path: cache, owner: s.config.host.id, projects: ['one'], managedOnly: true, retentionMs: 1000, classes: [] }];
  enrollArtifact(s.config, s.store, 'cache');
  const starting = runManaged(s.config, s.store, { root, projectId: 'one', sessionId: 'one', program: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(sentinel)},'bad')`] });
  fs.renameSync(cache, path.join(s.root, 'retained-cache')); fs.mkdirSync(cache);
  await assert.rejects(starting, /matching ownership|incarnation changed/);
  assert.equal(fs.existsSync(sentinel), false);
  assert.equal(s.store.list('claim')[0].value.state, 'unresolved');
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
  const agent = `require('fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},20);`;
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
    // Test teardown waits for job termination; it never releases the reservation.
    const agentPid = fs.existsSync(ready) ? Number(fs.readFileSync(ready, 'utf8')) : null;
    for (const pid of [helper, agentPid].filter(Boolean)) {
      await until(() => {
        try { process.kill(pid, 0); return false; }
        catch (error) { if (error.code !== 'ESRCH') throw error; return true; }
      });
    }
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
  assert.match(run('run', ['--issue', '7', ...command]).stderr, /--source.*--issue.*--attempt/);
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

test('native managed launch and GitHub approval qualify only the unchanged linked worktree', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const s = controller(t, binary);
  const root = path.join(s.base, 'checkout'), ready = path.join(s.base, 'ready'), gate = path.join(s.base, 'gate');
  git(s.root, 'config', 'worktrunk.default-branch', 'main');
  git(s.root, 'worktree', 'add', '-b', 'agent', root);
  const gitDir = git(root, 'rev-parse', '--absolute-git-dir');
  const initialHead = git(root, 'rev-parse', 'HEAD');
  const value = JSON.parse(fs.readFileSync(s.filename, 'utf8'));
  value.nativeHost = { path: host, version: 1, sha256: createHash('sha256').update(fs.readFileSync(host)).digest('hex') };
  value.eventSources = [{ id: 'issues', instance: 'issues-1', role: 'task', projects: ['myproject'], github: { repository: 'owner/repo', repositoryId: 22, acceptorIds: [5] } }];
  fs.writeFileSync(s.filename, JSON.stringify(value));
  const registry = JSON.parse(fs.readFileSync(value.registry, 'utf8'));
  registry.projects[0].producerAdmission = 'unsupported';
  fs.writeFileSync(value.registry, JSON.stringify(registry));
  assert.throws(() => loadConfig(s.filename), /Unsupported worktree producer admission contract/);
  registry.projects[0].producerAdmission = 'cooperative-windows-job-v1';
  fs.writeFileSync(value.registry, JSON.stringify(registry));
  const config = loadConfig(s.filename);
  let store;
  store = new Store(path.join(fixture(t, () => store?.close()), 'state'));
  const response = {
    'repos/owner/repo': { id: 22, full_name: 'Owner/Repo' },
    'repos/owner/repo/issues/7': { id: 38, number: 7, repository_url: 'https://api.github.com/repos/owner/repo' },
    'repos/owner/repo/issues/7/timeline?per_page=100': [[]],
  };
  const read = async endpoint => { assert.ok(Object.hasOwn(response, endpoint), endpoint); return response[endpoint]; };
  const agent = `
    const fs = require('fs');
    fs.writeFileSync(${JSON.stringify(ready)}, '');
    const wait = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(gate)})) return;
      clearInterval(wait);
      require('child_process').execFileSync('git', ['-c', 'user.name=Agent', '-c', 'user.email=agent@example.test', 'commit', '--allow-empty', '-m', 'Agent result'], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: ${JSON.stringify(path.join(s.base, 'empty-gitconfig'))} } });
      process.exitCode = 7;
    }, 20);
  `;
  const launch = { root, projectId: 'myproject', sessionId: 'bound', program: process.execPath, args: ['-e', agent], github: { source: 'issues', issue: 7, attempt: 1, agentId: 'agent-a' } };
  const copied = path.join(s.base, 'copied-checkout');
  fs.mkdirSync(copied);
  fs.copyFileSync(path.join(root, '.git'), path.join(copied, '.git'));
  await assert.rejects(runManaged(config, store, { ...launch, root: copied }, () => assert.fail('Unregistered checkout reached GitHub')), /exact registered worktree root/);
  await assert.rejects(runManaged(config, store, launch, () => assert.fail('Unenrolled checkout reached GitHub')), /matching enrollment/);
  const enrollment = enroll(store, root, gitDir);
  const running = runManaged(config, store, launch, read);
  running.catch(() => {});
  try {
    await until(() => fs.existsSync(ready));
    const claim = store.list('claim')[0].value;
    assert.equal(claim.state, 'running');
    assert.equal(claim.endedHead, undefined);
    assert.equal(report(config, store, { from: 0, to: Date.now() }).tasks.length, 0);
    const second = { ...launch, sessionId: 'second', args: ['-e', 'process.exit(99)'] };
    await assert.rejects(runManaged(config, store, second, read), /already has a launch claim/);
    await assert.rejects(runManaged(config, store, { ...second, github: undefined }), /exclusive producer admission/);
  } finally { fs.writeFileSync(gate, ''); await running; }
  const result = await running, claim = store.get('claim', result.token).value;
  assert.equal(result.exitCode, 7);
  assert.equal(claim.state, 'ended');
  assert.equal(claim.task.worktreeId, enrollment.id);
  assert.equal(claim.task.taskId, '38');
  assert.equal(claim.task.attempt, 1);
  assert.ok(claim.endedAt >= claim.admittedAt);
  assert.equal(claim.endedHead, git(root, 'rev-parse', 'HEAD'));
  assert.notEqual(claim.endedHead, initialHead);
  const task = report(config, store, { from: 0, to: Date.now() }).tasks[0];
  assert.equal(task.currentOutcome, 'unknown');
  assert.equal(task.attempts[0].managed.head, claim.endedHead);
  assert.equal(task.attempts[0].terminal, null);
  git(s.root, 'merge', '--ff-only', 'agent');
  const candidate = (project = config.projects[0], now = Date.now()) => {
    const scan = scanProject(config, store, project, now);
    assert.equal(scan.applyEnabled, false);
    return scan.decisions.find(item => item.branch === 'refs/heads/agent');
  };
  const approvedAt = Math.ceil(claim.endedAt / 1000) * 1000;
  await until(() => Date.now() >= approvedAt);
  const timestamp = new Date(approvedAt).toISOString().replace('.000Z', 'Z');
  response['repos/owner/repo/issues/7/timeline?per_page=100'] = [[{ event: 'commented', id: 90, user: { type: 'User', id: 5 }, created_at: timestamp, updated_at: timestamp, body: `/worktrunk accept 1 ${claim.endedHead}` }]];
  await syncGitHubIssue(config, store, 'issues', 7, read);
  const eligible = candidate();
  assert.equal(eligible.status, 'eligible', JSON.stringify(eligible));
  assert.equal(eligible.evidence.taskEvidence.acceptedAt, approvedAt);
  assert.equal(eligible.evidence.producerEvidence.status, 'inactive');
  assert.ok(candidate({ ...config.projects[0], producerAdmission: undefined }).reasons.includes('contract_unavailable'));
  assert.ok(candidate(config.projects[0], eligible.evidence.taskEvidence.observedAt + 5 * 60_000 + 1).reasons.includes('issue_observation_stale'));
  const protectedFile = path.join(root, 'protected.tmp');
  fs.appendFileSync(path.join(s.gitDir, 'info', 'exclude'), '\nprotected.tmp\n');
  fs.writeFileSync(protectedFile, 'unique agent data');
  assert.ok(candidate().reasons.includes('ignored_content_unclassified'));
  assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'unique agent data');
  fs.unlinkSync(protectedFile);
  const later = reserve(store, { roots: [root], owner: config.host.id, sessionId: 'unbound-later' });
  assert.ok(candidate().reasons.includes('active_or_unresolved_claim'));
  const evidence = { kind: 'windows_job', launchToken: later.token, helperPid: 1, activeProcesses: null };
  transition(store, later.token, 'reserved', 'starting');
  transition(store, later.token, 'starting', 'running', evidence);
  transition(store, later.token, 'running', 'ended', { ...evidence, activeProcesses: 1 });
  assert.equal(git(root, 'rev-parse', 'HEAD'), claim.endedHead);
  assert.ok(candidate().reasons.includes('checkout_producer_history_changed'));
  const marker = path.join(gitDir, 'worktrunk-controller-worktree.json');
  const changed = async endpoint => {
    if (endpoint.includes('/timeline?')) fs.renameSync(marker, `${marker}.replaced`);
    return read(endpoint);
  };
  await assert.rejects(runManaged(config, store, { ...launch, github: { ...launch.github, attempt: 2 } }, changed), /matching enrollment/);
  assert.equal(store.list('claim').length, 2);
});
