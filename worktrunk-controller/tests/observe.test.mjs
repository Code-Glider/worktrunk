import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../lib/store.mjs';
import { enroll } from '../lib/identity.mjs';
import { scanProject, inventoryContents, validateObservation } from '../lib/observe.mjs';
import { decideWorktree } from '../lib/policy.mjs';
import { loadConfig } from '../lib/config.mjs';
import { report } from '../lib/report.mjs';
import { controller, git, nativeWorktrunk } from './helpers.mjs';

const binary = nativeWorktrunk();

test('hidden tracked entries remain unknown for both index suppression flags', t => {
  const s = controller(t, binary);
  git(s.root, 'config', 'worktrunk.default-branch', 'main');
  fs.writeFileSync(path.join(s.root, 'tracked'), 'committed');
  git(s.root, 'add', 'tracked'); git(s.root, 'commit', '-m', 'Tracked content');
  const roots = ['assume', 'skip'].map(name => {
    const root = path.join(s.base, name);
    git(s.root, 'worktree', 'add', '-b', name, root);
    git(root, 'update-index', name === 'assume' ? '--assume-unchanged' : '--skip-worktree', 'tracked');
    fs.writeFileSync(path.join(root, 'tracked'), 'unique hidden work');
    return root;
  });
  const indices = roots.map(root => fs.readFileSync(path.join(git(root, 'rev-parse', '--absolute-git-dir'), 'index')));
  const store = new Store(s.state);
  try {
    const scan = scanProject(s.config, store, s.config.projects[0]);
    for (const [i, root] of roots.entries()) {
      const decision = scan.decisions.find(item => path.resolve(item.path) === root);
      assert.equal(decision.status, 'retain');
      assert.equal(decision.evidence.dirty, null);
      assert.ok(decision.reasons.includes('hidden_index_entries'));
      assert.equal(fs.readFileSync(path.join(root, 'tracked'), 'utf8'), 'unique hidden work');
      assert.deepEqual(fs.readFileSync(path.join(git(root, 'rev-parse', '--absolute-git-dir'), 'index')), indices[i]);
    }
  } finally { store.close(); }
});

test('real mixed-state scan protects ignored agent files, nested repositories and stale entries without mutation', t => {
  const s = controller(t, binary);
  git(s.root, 'config', 'worktrunk.default-branch', 'main');
  const roots = Object.fromEntries(['clean', 'dirty', 'ignored', 'nested', 'locked', 'stale'].map(name => {
    const root = path.join(s.base, `checkout ${name} א`); git(s.root, 'worktree', 'add', '-b', name, root); return [name, root];
  }));
  fs.writeFileSync(path.join(roots.dirty, 'agent.txt'), 'unique');
  const exclude = path.join(s.gitDir, 'info', 'exclude');
  fs.appendFileSync(exclude, '\n.archon/\nchild/\n');
  fs.mkdirSync(path.join(roots.ignored, '.archon')); fs.writeFileSync(path.join(roots.ignored, '.archon', 'config.yaml'), 'unique config');
  const child = path.join(roots.nested, 'child'); fs.mkdirSync(child); git(child, 'init', '-b', 'main'); fs.writeFileSync(path.join(child, 'unique'), 'child');
  git(s.root, 'worktree', 'lock', roots.locked);
  // The deletion is restricted to this disposable fixture's empty checkout.
  fs.rmSync(roots.stale, { recursive: true });
  const head = git(s.root, 'rev-parse', 'HEAD');
  const index = fs.readFileSync(path.join(s.gitDir, 'index'));
  const store = new Store(s.state);
  try {
    const admin = git(roots.clean, 'rev-parse', '--absolute-git-dir');
    enroll(store, roots.clean, admin, 'worktree', 1000);
    const scan = scanProject(s.config, store, s.config.projects[0], 2000);
    assert.equal(scan.decisions.length, 7);
    const byBranch = new Map(scan.decisions.map(decision => [decision.branch, decision]));
    for (const decision of scan.decisions) assert.notEqual(decision.status, 'eligible');
    assert.equal(byBranch.get('refs/heads/clean').status, 'retain', JSON.stringify(scan));
    assert.ok(byBranch.get('refs/heads/clean').reasons.includes('task_outcome_unavailable'));
    assert.ok(byBranch.get('refs/heads/dirty').reasons.includes('untracked_content'));
    assert.ok(byBranch.get('refs/heads/ignored').reasons.includes('ignored_content_unclassified'));
    assert.ok(byBranch.get('refs/heads/nested').reasons.includes('nested_repository'));
    assert.ok(byBranch.get('refs/heads/locked').reasons.includes('user_lock'));
    assert.ok(byBranch.get('refs/heads/stale').reasons.includes('stale_registration_report_only'));
    assert.equal(fs.readFileSync(path.join(roots.ignored, '.archon', 'config.yaml'), 'utf8'), 'unique config');
    assert.equal(fs.readFileSync(path.join(child, 'unique'), 'utf8'), 'child');
    assert.equal(git(s.root, 'rev-parse', 'HEAD'), head);
    assert.deepEqual(fs.readFileSync(path.join(s.gitDir, 'index')), index);
    assert.equal(git(s.root, 'worktree', 'list', '--porcelain').includes(roots.stale.replaceAll('\\', '/')), true);
  } finally { store.close(); }
});

test('unsupported callback configuration and changed executable pins fail every item closed', t => {
  const s = controller(t, binary);
  git(s.root, 'config', 'worktrunk.default-branch', 'main');
  const store = new Store(s.state);
  try {
    git(s.root, 'config', 'filter.test.clean', 'exit 1');
    const failed = scanProject(s.config, store, s.config.projects[0]);
    assert.ok(failed.decisions.every(decision => decision.status === 'analysis_failed'));
    git(s.root, 'config', '--unset', 'filter.test.clean');
    const changed = scanProject({ ...s.config, worktrunk: { ...s.config.worktrunk, sha256: 'a'.repeat(64) } }, store, s.config.projects[0]);
    assert.ok(changed.decisions.every(decision => decision.status === 'analysis_failed'));
    assert.match(changed.decisions[0].error, /hash changed/);
  } finally { store.close(); }
});

test('schema/profile absence is unknown and content bounds/links cannot authorize cleanup', t => {
  const s = controller(t, binary);
  assert.throws(() => validateObservation({ schema: 1 }), /profile\/schema/);
  assert.throws(() => validateObservation({ schema: 2, items: [], collected: { ci: false, summary: false }, repo: {} }), /snapshot/);
  fs.writeFileSync(path.join(s.root, 'large'), '12345');
  assert.throws(() => inventoryContents(s.root, { maxFiles: 10, maxBytes: 4 }), /byte limit/);
  fs.symlinkSync(s.root, path.join(s.root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(inventoryContents(s.root, { maxFiles: 10, maxBytes: 10 }).links, true);
  const facts = { main: false, defaultBranch: false, protectedPath: false, locked: false, stale: false, dirty: false, hiddenIndex: false, untracked: false, ignored: false, nested: false, links: false, operation: false, identity: 'managed', enrolledAt: 1, integration: 'same_commit', acceptedTask: true, inactiveProducers: true };
  assert.equal(decideWorktree(facts, s.config.policy, 1000).status, 'eligible');
  assert.ok(decideWorktree({ ...facts, ignored: true }, s.config.policy, 1000).reasons.includes('ignored_content_unclassified'));
  assert.ok(decideWorktree({ ...facts, enrolledAt: 2000 }, s.config.policy, 1000).reasons.includes('age_unknown'));
});

test('CLI scans in JSON and refuses unsupported mutation commands', t => {
  const s = controller(t, binary); git(s.root, 'config', 'worktrunk.default-branch', 'main');
  const cli = path.resolve(import.meta.dirname, '../bin/controller.mjs');
  const result = spawnSync(process.execPath, [cli, 'scan', '--config', s.filename, '--format', 'json'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(JSON.parse(result.stdout).applyEnabled, false);
  const unsupported = spawnSync(process.execPath, [cli, 'apply', '--config', s.filename], { encoding: 'utf8', windowsHide: true });
  assert.equal(unsupported.status, 1); assert.match(unsupported.stderr, /Usage:/);
});

test('native generic markers and Claude hooks record distinct sessions and survive recording failure', t => {
  const s = controller(t, binary);
  const raw = JSON.parse(fs.readFileSync(s.filename, 'utf8'));
  raw.eventSources = [{ id: 'host', instance: 'native-host', role: 'host', projects: ['myproject'] }];
  fs.writeFileSync(s.filename, JSON.stringify(raw));
  const config = loadConfig(s.filename);
  const emptyGit = path.join(s.base, 'observer-gitconfig'), emptyWt = path.join(s.base, 'observer.toml');
  fs.writeFileSync(emptyGit, ''); fs.writeFileSync(emptyWt, '');
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(WORKTRUNK_|GIT_)/i.test(key))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyGit, WORKTRUNK_CONFIG_PATH: emptyWt, WORKTRUNK_SYSTEM_CONFIG_PATH: emptyWt, WORKTRUNK_PROJECT_CONFIG_PATH: '', CLAUDE_PROJECT_DIR: s.root,
    WORKTRUNK_OBSERVER_NODE: process.execPath, WORKTRUNK_OBSERVER_SCRIPT: path.resolve(import.meta.dirname, '../bin/controller.mjs'), WORKTRUNK_OBSERVER_CONFIG: s.filename, WORKTRUNK_OBSERVER_SOURCE: 'host', WORKTRUNK_OBSERVER_PROJECT: 'myproject', WORKTRUNK_OBSERVER_SESSION: 'generic' };
  function run(args, payload) {
    const result = spawnSync(binary, args, { cwd: s.root, env, input: payload && JSON.stringify(payload), encoding: 'utf8', windowsHide: true, timeout: 5000 });
    assert.equal(result.status, 0, result.stderr); return result;
  }
  const hook = type => run(['config', 'plugins', 'claude', 'hook'], { hook_event_name: type, session_id: 'claude', prompt: 'secret prompt never persist' });
  run(['config', 'state', 'marker', 'set', '🤖']);
  hook('UserPromptSubmit'); hook('Stop');
  run(['config', 'state', 'marker', 'clear']);
  let store = new Store(s.state);
  try {
    const now = Date.now();
    const result = report(config, store, { from: now - 60000, to: now, now });
    assert.equal(result.sessions.length, 2);
    assert.equal(result.sessions.find(session => session.sessionId === 'generic').currentState, 'ended');
    const claude = result.sessions.find(session => session.sessionId === 'claude');
    assert.equal(claude.currentState, 'unknown'); assert.equal(claude.lastObservedState, 'waiting');
    assert.equal(result.observedFirstAcceptedTasks, 0);
    assert.equal(JSON.stringify(store.list('event')).includes('secret prompt'), false);
  } finally { store.close(); }
  hook('SessionEnd');
  env.WORKTRUNK_OBSERVER_SESSION = 'second';
  run(['config', 'state', 'marker', 'set', '🤖']);
  env.WORKTRUNK_OBSERVER_SESSION = 'third';
  run(['config', 'state', 'marker', 'set', '🤖']);
  env.WORKTRUNK_OBSERVER_SESSION = 'second';
  run(['config', 'state', 'marker', 'clear']);
  env.WORKTRUNK_OBSERVER_SESSION = 'third';
  run(['config', 'state', 'marker', 'clear']);
  store = new Store(s.state);
  let recorded;
  try { recorded = store.list('event').length; assert.equal(store.list('event').filter(row => row.value.event.type === 'session_ended').length, 4); } finally { store.close(); }
  for (const session_id of [42, {}, null, '']) run(['config', 'plugins', 'claude', 'hook'], { hook_event_name: 'UserPromptSubmit', session_id });
  store = new Store(s.state);
  try { assert.equal(store.list('event').length, recorded); } finally { store.close(); }
  assert.equal(JSON.parse(git(s.root, 'config', '--get', 'worktrunk.state.main.marker')).marker, '🤖');
  fs.writeFileSync(path.join(s.state, 'controller.sqlite'), 'damaged evidence');
  run(['config', 'state', 'marker', 'set', '🤖']); hook('Stop');
  assert.equal(JSON.parse(git(s.root, 'config', '--get', 'worktrunk.state.main.marker')).marker, '💬');
  assert.equal(fs.readFileSync(path.join(s.state, 'controller.sqlite'), 'utf8'), 'damaged evidence');
});

test('CLI ingests authoritative events and reports JSON/text with a strict UTC window', t => {
  const s = controller(t, binary);
  const raw = JSON.parse(fs.readFileSync(s.filename, 'utf8'));
  raw.eventSources = [{ id: 'tasks', instance: 'tracker', role: 'task', authority: 'test-tracker', projects: ['myproject'] }];
  fs.writeFileSync(s.filename, JSON.stringify(raw));
  const cli = path.resolve(import.meta.dirname, '../bin/controller.mjs');
  const invoke = (args, input) => spawnSync(process.execPath, [cli, ...args, '--config', s.filename], { input, encoding: 'utf8', windowsHide: true });
  const event = { version: 1, eventId: 'accepted', project: 'myproject', type: 'attempt_accepted', taskId: '1', authorityProject: 'p', attemptId: '1', attemptNumber: 1, at: Date.parse('2026-11-03T12:00:00Z') };
  assert.equal(invoke(['report', '--from', '2026-02-30', '--to', '2026-11-05']).status, 1);
  assert.equal(fs.existsSync(s.state), false);
  assert.equal(invoke(['report', '--from', '2026-11-02', '--to', '2026-11-05']).status, 1);
  assert.equal(fs.existsSync(s.state), false);
  const result = invoke(['ingest', '--source', 'tasks', '--format', 'json'], JSON.stringify(event));
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).replay, false);
  const args = ['report', '--from', '2026-11-02', '--to', '2026-11-05'];
  const filename = path.join(s.state, 'controller.sqlite'), before = fs.readFileSync(filename), mtime = fs.statSync(filename).mtimeMs;
  const json = invoke([...args, '--format', 'json']); assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).observedFirstAcceptedTasks, 1);
  assert.match(invoke(args).stdout, /Observed first accepted tasks: 1/);
  assert.deepEqual(fs.readFileSync(filename), before); assert.equal(fs.statSync(filename).mtimeMs, mtime);
  assert.deepEqual(fs.readdirSync(s.state), ['controller.sqlite']);
  assert.equal(invoke(['report', '--from', '2026-02-30', '--to', '2026-11-05']).status, 1);
  assert.equal(invoke(['ingest', '--source', 'tasks'], JSON.stringify({ ...event, raw: 'secret' })).status, 1);
});
