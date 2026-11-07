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
import { beginWorktreeAction, beginWorktreePurge, inspectWorktreeQuarantine, lockWorktreeQuarantine, moveWorktreeToQuarantine, purgeWorktree, reconcile, refreshWorktreeAuthority, refreshWorktreePurgeAuthority, restoreWorktree, verifyWorktreeAction, verifyWorktreePurge } from '../lib/actions.mjs';
import { acquireCleanup, inactive, releaseCleanup, reserve, transition } from '../lib/admission.mjs';
import { enrollArtifact } from '../lib/artifacts.mjs';
import { loadConfig } from '../lib/config.mjs';
import { syncGitHubIssue } from '../lib/events.mjs';
import { enroll } from '../lib/identity.mjs';
import { runManaged } from '../lib/managed.mjs';
import { readCommandCompletion, runJournaledCommand } from '../lib/native-host.mjs';
import { scanProject } from '../lib/observe.mjs';
import { report } from '../lib/report.mjs';
import { retentionStatus, sampleClock } from '../lib/retention.mjs';
import { controller, fixture, git, nativeWorktrunk } from './helpers.mjs';

const host = nativeWorktrunk('wt-controller-host');
const binary = process.platform === 'win32' ? nativeWorktrunk() : null;

function worktreeFixture(t) {
  const s = controller(t, binary);
  git(s.root, 'config', 'worktrunk.default-branch', 'main');
  const tracked = 'tracked-sentinel.txt';
  fs.writeFileSync(path.join(s.root, tracked), 'committed checkout data');
  git(s.root, 'add', '--', tracked);
  git(s.root, 'commit', '-m', 'Add the tracked fixture');
  const raw = JSON.parse(fs.readFileSync(s.filename, 'utf8'));
  raw.policy.allowApply = true;
  raw.nativeHost = { path: host, version: 1, sha256: createHash('sha256').update(fs.readFileSync(host)).digest('hex') };
  raw.eventSources = [{ id: 'issues', instance: 'issues-1', role: 'task', projects: ['myproject'], github: { repository: 'owner/repo', repositoryId: 22, acceptorIds: [5] } }];
  fs.writeFileSync(s.filename, JSON.stringify(raw));
  fs.writeFileSync(raw.registry, JSON.stringify({ projects: [{ id: 'myproject', root: s.root, producerAdmission: 'cooperative-windows-job-v1' }] }));
  const config = loadConfig(s.filename), store = new Store(config.stateDir), project = config.projects[0];
  const fixtures = new Map();
  const read = async endpoint => {
    if (endpoint === 'repos/owner/repo') return { id: 22, full_name: 'owner/repo' };
    const [, issue, tail] = /^repos\/owner\/repo\/issues\/(\d+)(.*)$/.exec(endpoint);
    if (tail) return [fixtures.get(Number(issue))];
    return { id: 30 + Number(issue), number: Number(issue), repository_url: 'https://api.github.com/repos/owner/repo' };
  };
  async function accept(issue) {
    const branch = `agent-${issue}`, root = path.join(s.base, branch);
    git(s.root, 'worktree', 'add', '-b', branch, root);
    enroll(store, root, git(root, 'rev-parse', '--absolute-git-dir'));
    fixtures.set(issue, []);
    const launch = await runManaged(config, store, { root, projectId: project.id, sessionId: branch, program: process.execPath, args: ['-e', ''], github: { source: 'issues', issue, attempt: 1 } }, read);
    const claim = store.get('claim', launch.token).value;
    const acceptedAt = Math.ceil(claim.endedAt / 1000) * 1000;
    await until(() => Date.now() >= acceptedAt);
    const at = new Date(acceptedAt).toISOString().replace('.000Z', 'Z');
    fixtures.set(issue, [{ event: 'commented', id: 80 + issue, user: { type: 'User', id: 5 }, created_at: at, updated_at: at, body: `/worktrunk accept 1 ${claim.endedHead}` }]);
    await syncGitHubIssue(config, store, 'issues', issue, read);
  }
  return { s, tracked, raw, config, store, project, fixtures, read, accept };
}

function worktreeCliFixture(t) {
  let store;
  t.after(() => store?.close());
  const fixture = worktreeFixture(t);
  ({ store } = fixture);
  const { s, fixtures } = fixture;
  const folder = path.join(s.base, 'github fixture');
  fs.mkdirSync(folder);
  const source = fileURLToPath(new URL('./fixtures/gh-read.rs', import.meta.url));
  const build = spawnSync('rustc', [source, '-o', path.join(folder, 'gh.exe')], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(build.status, 0, build.stderr || build.error?.message);
  const write = (name, value) => fs.writeFileSync(path.join(folder, name), JSON.stringify(value));
  write('repo.json', { id: 22, full_name: 'owner/repo' });
  write('issue.json', { id: 37, number: 7, repository_url: 'https://api.github.com/repos/owner/repo' });
  const timeline = (events = fixtures.get(7)) => write('timeline.json', [events]);
  const env = { ...process.env };
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'Path';
  env[pathKey] = `${folder}${path.delimiter}${env[pathKey] ?? ''}`;
  const cli = fileURLToPath(new URL('../bin/controller.mjs', import.meta.url));
  const invoke = (args, format = 'json') => spawnSync(process.execPath, [cli, '--config', s.filename, '--format', format, ...args],
    { env, encoding: 'utf8', windowsHide: true, timeout: 45000 });
  const run = args => {
    const result = invoke(args);
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return JSON.parse(result.stdout);
  };
  return { ...fixture, timeline, invoke, run, env };
}

test('public CLI selects a worktree for quarantine and restores it with apply disabled', { skip: process.platform !== 'win32', timeout: 120000 }, async t => {
  const { s, tracked, raw, store, accept, timeline, invoke, run } = worktreeCliFixture(t);
  await accept(7);
  timeline();
  const snapshot = run(['scan', '--project', 'myproject']);
  assert.equal(snapshot.worktreeApplyEnabled, true);
  const selected = snapshot.projects[0].decisions.find(decision => decision.branch === 'refs/heads/agent-7');
  assert.equal(selected.status, 'eligible', JSON.stringify(selected));
  const originalRegistration = git(selected.path, 'rev-parse', '--absolute-git-dir');
  assert.equal(invoke(['purge', '--decision', selected.id]).status, 1);
  raw.policy.allowApply = false;
  fs.writeFileSync(s.filename, JSON.stringify(raw));
  const disabled = invoke(['apply', '--decision', selected.id]);
  assert.equal(disabled.status, 1);
  assert.match(disabled.stderr, /Worktree apply requires explicit policy/);
  assert.equal(store.list('action').length, 0);
  assert.equal(fs.existsSync(selected.path), true);
  raw.policy.allowApply = true;
  fs.writeFileSync(s.filename, JSON.stringify(raw));

  const action = run(['apply', '--decision', selected.id]);
  assert.equal(action.kind, 'worktree');
  assert.equal(action.phase, 'quarantined');
  assert.equal(fs.existsSync(selected.path), false);
  assert.equal(git(action.payloadPath, 'rev-parse', 'HEAD'), selected.head);
  assert.match(fs.readFileSync(path.join(action.command.gitDir, 'locked'), 'utf8'), new RegExp(action.id));

  raw.policy.allowApply = false;
  fs.writeFileSync(s.filename, JSON.stringify(raw));
  const restored = run(['restore', '--action', action.id]);
  assert.equal(restored.phase, 'restored');
  assert.equal(run(['reconcile', '--action', action.id]).phase, 'restored');
  assert.equal(fs.readFileSync(path.join(selected.path, tracked), 'utf8'), 'committed checkout data');
  assert.equal(git(selected.path, 'rev-parse', '--absolute-git-dir'), originalRegistration);
  assert.equal(git(selected.path, 'symbolic-ref', 'HEAD'), selected.branch);
});

test('disposable runner and CLI preserve work until a newly reviewed GitHub acceptance permits purge', { skip: process.platform !== 'win32', timeout: 150000 }, async t => {
  const { s, config, tracked, store, timeline, invoke, run, env } = worktreeCliFixture(t);
  const checkout = path.join(s.base, 'agent worktree א');
  const sibling = path.join(s.base, 'sibling');
  git(s.root, 'worktree', 'add', '-b', 'agent-7', checkout);
  git(s.root, 'worktree', 'add', '-b', 'sibling', sibling);
  const siblingSentinel = path.join(sibling, 'unfinished.txt');
  fs.writeFileSync(siblingSentinel, 'unique sibling data');
  const registrations = git(s.root, 'worktree', 'list', '--porcelain');
  const branch = 'refs/heads/agent-7', head = git(checkout, 'rev-parse', 'HEAD');
  run(['enroll', '--project', 'myproject', '--path', checkout]);
  timeline([]);
  const launch = run(['run', '--project', 'myproject', '--path', checkout, '--session', 'pilot', '--source', 'issues',
    '--issue', '7', '--attempt', '1', '--agent', 'fixture-agent', '--program', process.execPath, '--', '-e', '']);
  const claim = store.get('claim', launch.token).value;
  assert.equal(claim.state, 'ended');
  assert.equal(claim.endedHead, head);
  const acceptedAt = Math.ceil(claim.endedAt / 1000) * 1000;
  await until(() => Date.now() >= acceptedAt);
  const timestamp = at => new Date(at).toISOString().replace('.000Z', 'Z');
  const accepted = { event: 'commented', id: 87, user: { type: 'User', id: 5 }, created_at: timestamp(acceptedAt),
    updated_at: timestamp(acceptedAt), body: `/worktrunk accept 1 ${head}` };
  timeline([accepted]);
  assert.equal(store.list('event').length, 0);

  const runner = fileURLToPath(new URL('../scheduling/scan-report.ps1', import.meta.url));
  let selected;
  for (let cycle = 0; cycle < 2; cycle++) {
    if (cycle === 1) timeline(null);
    const result = spawnSync(process.env.PWSH_PATH ?? 'pwsh', ['-NoProfile', '-NonInteractive', '-File', runner,
      '-Node', process.execPath, '-Config', s.filename, '-TimeoutSeconds', '35', '-SyncGitHubIssues'], { env, encoding: 'utf8', windowsHide: true, timeout: 42000 });
    assert.equal(result.status, cycle, result.stderr || result.error?.message);
    if (cycle === 0) assert.match(result.stdout, /Refreshed 1 tracked GitHub issues\. 0 failed\./);
    else {
      assert.match(result.stderr, /GitHub issue #7 from issues\. Invalid GitHub issue timeline/);
      assert.match(result.stderr, /GitHub issue refresh failed with exit 1/);
    }
    assert.match(result.stdout, /worktree apply enabled/);
    assert.match(result.stdout, /Observed first accepted tasks:/);
    assert.deepEqual(store.list('event').map(row => row.value.event.type), ['attempt_accepted']);
    const current = store.get('scan', 'myproject').value.decisions.find(decision => decision.branch === branch);
    assert.equal(current.status, 'eligible', JSON.stringify(current));
    if (selected) assert.equal(current.id, selected.id);
    selected = current;
    assert.equal(store.list('action').length, 0);
    assert.equal(git(s.root, 'worktree', 'list', '--porcelain'), registrations);
    assert.equal(fs.readFileSync(path.join(checkout, tracked), 'utf8'), 'committed checkout data');
  }

  timeline([accepted]);
  const action = run(['apply', '--decision', selected.id]);
  assert.equal(action.phase, 'quarantined');
  await until(() => retentionStatus(action.retentionClock, sampleClock(), config.policy.retentionMs) === null);
  const review = () => {
    const scan = run(['scan', '--action', action.id]);
    assert.deepEqual(scan.artifacts, []);
    assert.equal(scan.projects[0].project, 'myproject');
    const [decision] = scan.projects[0].decisions;
    assert.equal(decision.kind, 'worktree_purge');
    assert.equal(decision.actionId, action.id);
    return decision;
  };
  const first = review();
  assert.equal(first.status, 'eligible', JSON.stringify(first));
  assert.equal(invoke(['apply', '--decision', first.id]).status, 1);
  const lock = path.join(action.command.gitDir, 'locked'), lockBytes = fs.readFileSync(lock);
  const reopenedAt = acceptedAt + 1000;
  await until(() => Date.now() >= reopenedAt);
  const reopened = { event: 'reopened', id: 102, created_at: timestamp(reopenedAt) };
  timeline([accepted, reopened]);
  const rejected = invoke(['purge', '--decision', first.id]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /issue_reopened/);
  assert.equal(run(['reconcile', '--action', action.id]).phase, 'quarantined');
  assert.deepEqual(fs.readFileSync(lock), lockBytes);
  assert.equal(fs.readFileSync(path.join(action.payloadPath, tracked), 'utf8'), 'committed checkout data');
  const reportArgs = ['report', '--project', 'myproject', '--from', '1970-01-01', '--to', '2000-01-01'];
  const reopenedReport = run(reportArgs);
  assert.equal(reopenedReport.tasks[0].currentOutcome, 'reopened');
  assert.equal(reopenedReport.tasks[0].firstAcceptedAt, acceptedAt);
  assert.deepEqual(reopenedReport.tasks[0].agentIds, ['fixture-agent']);
  assert.equal(reopenedReport.coverage[0].status, 'partial_unmeasured');
  assert.equal(reopenedReport.actions[0].phase, 'quarantined');

  const approvedAt = reopenedAt + 1000;
  await until(() => Date.now() >= approvedAt);
  timeline([accepted, reopened, { ...accepted, id: 88, created_at: timestamp(approvedAt), updated_at: timestamp(approvedAt) }]);
  const refreshed = run(['sync-github-issues']);
  assert.deepEqual(refreshed.failed, []);
  assert.deepEqual(refreshed.synced.map(row => [row.issue, row.recorded, row.replayed]), [[7, 1, 2]]);
  const approved = review();
  assert.equal(approved.status, 'eligible', JSON.stringify(approved));
  assert.notEqual(approved.id, first.id);
  const purged = run(['purge', '--decision', approved.id]);
  assert.equal(purged.phase, 'purged');
  assert.equal(fs.existsSync(action.payloadPath), false);
  assert.equal(fs.existsSync(action.command.gitDir), false);
  assert.equal(git(s.root, 'rev-parse', branch), head);
  assert.equal(fs.readFileSync(siblingSentinel, 'utf8'), 'unique sibling data');
  assert.equal(git(sibling, 'symbolic-ref', 'HEAD'), 'refs/heads/sibling');

  const state = path.join(s.state, 'controller.sqlite'), before = fs.readFileSync(state);
  const completed = run(reportArgs);
  assert.equal(completed.tasks[0].currentOutcome, 'accepted');
  assert.deepEqual(completed.artifactPurges, { observedActions: 0, logicalBytes: 0, unavailableTimeActions: 0 });
  assert.deepEqual(completed.actions.map(item => [item.id, item.kind, item.project, item.phase, item.purgeOutcome]),
    [[action.id, 'worktree', 'myproject', 'purged', 'complete']]);
  const rendered = invoke(reportArgs, 'text');
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, new RegExp(`Worktree action ${action.id} \\(myproject\\): purged`));
  assert.deepEqual(fs.readFileSync(state), before);
});

test('worktree cleanup intent owns the checkout and repository through quarantine and restore recovery', { skip: process.platform !== 'win32', timeout: 120000 }, async t => {
  const { s, tracked, raw, config, store, project, fixtures, read, accept } = worktreeFixture(t);
  try {
    for (const issue of [7, 8]) await accept(issue);
    const scan = scanProject(config, store, project);
    const candidates = scan.decisions.filter(decision => decision.status === 'eligible');
    assert.equal(candidates.length, 2, JSON.stringify(candidates));
    assert.deepEqual(scan.eligibleCandidates.map(candidate => [candidate.decisionId, candidate.path, candidate.logicalBytes, candidate.rebuildFiles]),
      candidates.map(decision => [decision.id, decision.path, fs.statSync(path.join(decision.path, tracked)).size, 1]));
    store.transaction(tx => { for (const decision of candidates) tx.put('decision', decision.id, { version: 1, ...decision, policyGeneration: config.generation }); });
    const [selected, other] = candidates;
    const independent = path.join(s.base, 'independent');
    fs.mkdirSync(independent);
    git(independent, 'init');
    const action = beginWorktreeAction(config, store, selected.id);
    assert.equal(action.phase, 'intent');
    assert.equal(store.get('claim', action.claimToken).value.state, 'held');
    assert.throws(() => beginWorktreeAction(config, store, other.id), /owner\/cleanup claim/);
    assert.throws(() => reserve(store, { roots: [selected.path], owner: config.host.id, sessionId: 'competing' }), /Cleanup claim/);
    assert.throws(() => reserve(store, { roots: [other.path], owner: config.host.id, sessionId: 'sibling' }), /Cleanup claim/);
    assert.equal(reserve(store, { roots: [independent], owner: config.host.id, sessionId: 'independent' }).state, 'reserved');
    assert.equal(store.list('action').length, 1);
    const verify = revision => store.transaction(tx => verifyWorktreeAction(config, tx, action.id, revision));
    assert.throws(() => verify(action.initialIssueRevision), /snapshot superseded or unavailable/);
    const fresh = () => refreshWorktreeAuthority(config, store, action.id, read);
    const revision = await refreshWorktreeAuthority(config, store, action.id, async endpoint => {
      assert.throws(() => reserve(store, { roots: [other.path], owner: config.host.id, sessionId: 'during-refresh' }), /Cleanup claim/);
      return read(endpoint);
    });
    assert.equal(verify(revision).evidence.taskEvidence.acceptanceId, selected.evidence.taskEvidence.acceptanceId);
    const newer = await fresh();
    assert.throws(() => verify(revision), /snapshot superseded/);
    const protectedFile = path.join(selected.path, 'producer-output.tmp');
    fs.writeFileSync(protectedFile, 'unique data');
    assert.throws(() => verify(newer), /untracked_content/);
    assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'unique data');
    fs.unlinkSync(protectedFile);
    git(s.root, 'branch', 'extra-ref');
    assert.throws(() => verify(newer), /decision changed/);
    git(s.root, 'branch', '-d', 'extra-ref');
    const extraCheckout = path.join(s.base, 'extra-checkout');
    git(s.root, 'worktree', 'add', '--detach', extraCheckout);
    assert.throws(() => verify(newer), /checkout paths changed/);
    git(s.root, 'worktree', 'remove', extraCheckout);
    fs.writeFileSync(s.filename, JSON.stringify({ ...raw, policy: { ...raw.policy, allowApply: false } }));
    assert.throws(() => verify(newer), /configuration changed/);
    await assert.rejects(refreshWorktreeAuthority(config, store, action.id, () => assert.fail('Changed policy reached GitHub')), /configuration changed/);
    fs.writeFileSync(s.filename, JSON.stringify(raw));
    const [approval] = fixtures.get(action.issue);
    await until(() => Date.now() >= Date.parse(approval.created_at) + 1000);
    const reopenedAt = new Date(Date.parse(approval.created_at) + 1000).toISOString().replace('.000Z', 'Z');
    fixtures.set(action.issue, [approval, { event: 'reopened', id: 101, created_at: reopenedAt }]);
    const reopened = await fresh();
    assert.throws(() => verify(reopened), /issue_reopened/);
    assert.equal(fs.existsSync(config.quarantineDir), false);
    fs.mkdirSync(action.containerPath, { recursive: true });
    assert.throws(() => reconcile(config, store, action.id), /Unverified quarantine container/);
    assert.equal(store.get('claim', action.claimToken).value.state, 'held');
    fs.rmdirSync(action.containerPath);
    fs.rmdirSync(action.quarantineRoot);
    const restarted = new Store(config.stateDir);
    try {
      assert.equal(reconcile(config, restarted, action.id).phase, 'cancelled');
      assert.equal(restarted.get('claim', action.claimToken).value.state, 'released');
      assert.equal(reconcile(config, restarted, action.id).phase, 'cancelled');
    } finally { restarted.close(); }
    assert.equal(git(selected.path, 'rev-parse', 'HEAD'), selected.head);
    assert.equal(git(other.path, 'rev-parse', 'HEAD'), other.head);
    const writer = reserve(store, { roots: [s.root], owner: config.host.id, sessionId: 'before-intent' });
    assert.throws(() => beginWorktreeAction(config, store, selected.id), /owner\/cleanup claim/);
    const job = { kind: 'windows_job', launchToken: writer.token, helperPid: 1, activeProcesses: null };
    transition(store, writer.token, 'reserved', 'starting');
    transition(store, writer.token, 'starting', 'running', job);
    transition(store, writer.token, 'running', 'ended', { ...job, activeProcesses: 1 });
    const retry = beginWorktreeAction(config, store, other.id);
    const late = await refreshWorktreeAuthority(config, store, retry.id, endpoint => {
      if (endpoint.includes('/timeline?')) reconcile(config, store, retry.id);
      return read(endpoint);
    });
    assert.throws(() => store.transaction(tx => verifyWorktreeAction(config, tx, retry.id, late)), /Unstarted worktree intent required/);
    assert.equal(store.get('claim', retry.claimToken).value.state, 'released');

    const bytes = fs.readFileSync(path.join(other.path, tracked));
    const beforeLock = await moveWorktreeToQuarantine(config, store, other.id, read);
    assert.equal(beforeLock.phase, 'moved');
    const returned = await restoreWorktree(config, store, beforeLock.id);
    assert.equal(returned.phase, 'restored');
    assert.equal(store.get('identity', beforeLock.worktreeId).value.path, beforeLock.originalPath);
    assert.equal(store.get('claim', beforeLock.claimToken).value.state, 'released');
    assert.deepEqual(fs.readFileSync(path.join(other.path, tracked)), bytes);
    store.db.exec("CREATE TRIGGER fail_move BEFORE INSERT ON records WHEN NEW.kind='action' AND json_extract(NEW.body,'$.phase')='moved' BEGIN SELECT RAISE(ABORT,'injected move completion failure'); END;");
    await assert.rejects(moveWorktreeToQuarantine(config, store, other.id, read), /move completion failure/);
    store.db.exec('DROP TRIGGER fail_move');
    const pending = store.list('action').find(({ value }) => value.phase === 'moving').value;
    assert.equal(readCommandCompletion(config, pending.command.launch).exitCode, 0);
    assert.equal(store.get('identity', pending.worktreeId).value.path, pending.originalPath);
    assert.equal(store.get('claim', pending.claimToken).value.state, 'held');
    assert.equal(fs.existsSync(pending.originalPath), false);
    assert.deepEqual(fs.readFileSync(path.join(pending.payloadPath, tracked)), bytes);

    const registration = path.join(pending.command.gitDir, 'gitdir');
    const savedRegistration = fs.readFileSync(registration);
    try {
      fs.writeFileSync(registration, `${path.join(pending.originalPath, '.git')}\n`);
      assert.throws(() => reconcile(config, store, pending.id), /registered worktree root/);
      assert.equal(store.get('identity', pending.worktreeId).value.path, pending.originalPath);
      assert.equal(store.get('claim', pending.claimToken).value.state, 'held');
    } finally { fs.writeFileSync(registration, savedRegistration); }

    const recovering = new Store(config.stateDir);
    try {
      const moved = reconcile(config, recovering, pending.id);
      assert.equal(moved.phase, 'moved');
      assert.equal(moved.moveExitCode, 0);
      assert.equal(recovering.get('identity', moved.worktreeId).value.path, moved.payloadPath);
      assert.equal(recovering.get('claim', moved.claimToken).value.roots[0].currentPath, moved.payloadPath);
      assert.equal(reconcile(config, recovering, moved.id).phase, 'moved');
      assert.equal(git(moved.payloadPath, 'rev-parse', 'HEAD'), other.head);
      assert.equal(git(selected.path, 'rev-parse', 'HEAD'), selected.head);
      assert.throws(() => reserve(recovering, { roots: [s.root], owner: config.host.id, sessionId: 'after-move' }), /Cleanup claim/);

      const lock = path.join(moved.command.gitDir, 'locked');
      git(s.root, 'worktree', 'lock', '--reason', 'user lock', '--', moved.payloadPath);
      await assert.rejects(lockWorktreeQuarantine(config, recovering, moved.id), /already locked/);
      assert.equal(fs.readFileSync(lock, 'utf8').trim(), 'user lock');
      git(s.root, 'worktree', 'unlock', '--', moved.payloadPath);
      recovering.db.exec("CREATE TRIGGER fail_lock BEFORE INSERT ON records WHEN NEW.kind='action' AND json_extract(NEW.body,'$.phase')='quarantined' BEGIN SELECT RAISE(ABORT,'injected lock completion failure'); END;");
      await assert.rejects(lockWorktreeQuarantine(config, recovering, moved.id), /lock completion failure/);
      recovering.db.exec('DROP TRIGGER fail_lock');
      const locking = recovering.get('action', moved.id).value;
      assert.equal(locking.phase, 'locking');
      assert.equal(readCommandCompletion(config, locking.lockCommand.launch).exitCode, 0);
      const lockBytes = fs.readFileSync(lock);
      fs.writeFileSync(lock, 'different lock owner\n');
      try { assert.throws(() => reconcile(config, recovering, moved.id), /lock ownership differs/); }
      finally { fs.writeFileSync(lock, lockBytes); }
      const quarantined = reconcile(config, recovering, moved.id);
      assert.equal(quarantined.phase, 'quarantined');
      assert.equal(quarantined.lockCommand.exitCode, 0);
      assert.equal(quarantined.quarantinedAt, quarantined.retentionClock.wallMs);
      assert.equal(recovering.get('claim', moved.claimToken).value.state, 'held');
      assert.equal(fs.readFileSync(lock, 'utf8').trim(), `worktrunk-controller quarantine ${moved.id}`);
      assert.throws(() => reserve(recovering, { roots: [moved.payloadPath], owner: config.host.id, sessionId: 'stable-payload' }), /Cleanup claim/);

      const sibling = reserve(recovering, { roots: [s.root], owner: config.host.id, sessionId: 'stable-sibling' });
      await assert.rejects(restoreWorktree(config, recovering, moved.id), /owner\/cleanup claim/);
      assert.equal(recovering.get('action', moved.id).value.phase, 'quarantined');
      assert.deepEqual(fs.readFileSync(lock), lockBytes);
      const siblingJob = { kind: 'windows_job', launchToken: sibling.token, helperPid: 1, activeProcesses: null };
      transition(recovering, sibling.token, 'reserved', 'starting');
      transition(recovering, sibling.token, 'starting', 'running', siblingJob);
      transition(recovering, sibling.token, 'running', 'ended', { ...siblingJob, activeProcesses: 1 });

      fs.mkdirSync(moved.originalPath);
      try { await assert.rejects(restoreWorktree(config, recovering, moved.id), /locations are ambiguous/); }
      finally { fs.rmdirSync(moved.originalPath); }
      const oldLock = `${lock}.original`;
      fs.renameSync(lock, oldLock);
      fs.writeFileSync(lock, lockBytes);
      try {
        await assert.rejects(restoreWorktree(config, recovering, moved.id), /lock incarnation changed/);
        assert.deepEqual(fs.readFileSync(lock), lockBytes);
      } finally {
        fs.unlinkSync(lock);
        fs.renameSync(oldLock, lock);
      }

      const siblingAddedDuringQuarantine = path.join(s.base, 'new-sibling');
      git(s.root, 'worktree', 'add', '--detach', siblingAddedDuringQuarantine);
      const [accepted] = fixtures.get(moved.issue);
      const reopenedTime = Date.parse(accepted.created_at) + 1000;
      await until(() => Date.now() >= reopenedTime);
      fixtures.set(moved.issue, [accepted, { event: 'reopened', id: 102, created_at: new Date(reopenedTime).toISOString().replace('.000Z', 'Z') }]);
      await syncGitHubIssue(config, recovering, 'issues', moved.issue, read);
      fs.writeFileSync(s.filename, JSON.stringify({ ...raw, policy: { ...raw.policy, allowApply: false } }));
      const restoreConfig = loadConfig(s.filename);
      recovering.db.exec("CREATE TRIGGER fail_unlock BEFORE INSERT ON records WHEN NEW.kind='action' AND json_extract(NEW.body,'$.phase')='unlocked' BEGIN SELECT RAISE(ABORT,'injected unlock completion failure'); END;");
      await assert.rejects(restoreWorktree(restoreConfig, recovering, moved.id), /unlock completion failure/);
      recovering.db.exec('DROP TRIGGER fail_unlock');
      const unlocking = recovering.get('action', moved.id).value;
      assert.equal(unlocking.phase, 'unlocking');
      assert.equal(readCommandCompletion(config, unlocking.unlockCommand.launch).exitCode, 0);
      assert.equal(fs.existsSync(lock), false);
      assert.throws(() => reserve(recovering, { roots: [s.root], owner: config.host.id, sessionId: 'during-unlock' }), /Cleanup claim/);
      assert.equal(reconcile(restoreConfig, recovering, moved.id).phase, 'unlocked');
      assert.equal(recovering.get('claim', moved.claimToken).value.state, 'held');
      assert.throws(() => reserve(recovering, { roots: [siblingAddedDuringQuarantine], owner: config.host.id, sessionId: 'new-sibling' }), /Cleanup claim/);
      fs.mkdirSync(moved.originalPath);
      const occupant = path.join(moved.originalPath, 'occupant.txt');
      fs.writeFileSync(occupant, 'existing data');
      try {
        await assert.rejects(restoreWorktree(restoreConfig, recovering, moved.id), /locations are ambiguous/);
        assert.equal(fs.readFileSync(occupant, 'utf8'), 'existing data');
      } finally {
        fs.unlinkSync(occupant);
        fs.rmdirSync(moved.originalPath);
      }

      const unique = 'preserve-on-restore.txt';
      fs.writeFileSync(path.join(moved.payloadPath, unique), 'additional data');
      recovering.db.exec("CREATE TRIGGER fail_restore BEFORE INSERT ON records WHEN NEW.kind='action' AND json_extract(NEW.body,'$.phase')='restored' BEGIN SELECT RAISE(ABORT,'injected restore completion failure'); END;");
      await assert.rejects(restoreWorktree(restoreConfig, recovering, moved.id), /restore completion failure/);
      recovering.db.exec('DROP TRIGGER fail_restore');
      const restoring = recovering.get('action', moved.id).value;
      assert.equal(restoring.phase, 'restoring');
      assert.equal(readCommandCompletion(restoreConfig, restoring.restoreCommand.launch).exitCode, 0);
      const receipt = path.join(config.stateDir, `${restoring.restoreCommand.launch.evidence.launchToken}.native-completion`);
      fs.renameSync(receipt, `${receipt}.held`);
      try { assert.throws(() => reconcile(restoreConfig, recovering, moved.id), /Native worktree restore completion unavailable/); }
      finally { fs.renameSync(`${receipt}.held`, receipt); }
      assert.equal(recovering.get('identity', moved.worktreeId).value.path, moved.payloadPath);
      assert.equal(recovering.get('claim', moved.claimToken).value.state, 'held');
      assert.equal(fs.existsSync(moved.payloadPath), false);
      const afterRestore = new Store(config.stateDir);
      try {
        const restored = reconcile(restoreConfig, afterRestore, moved.id);
        assert.equal(restored.phase, 'restored');
        assert.equal(afterRestore.get('identity', moved.worktreeId).value.path, moved.originalPath);
        assert.equal(afterRestore.get('claim', moved.claimToken).value.state, 'released');
        assert.deepEqual(await restoreWorktree(restoreConfig, afterRestore, moved.id), restored);
        assert.equal(reserve(afterRestore, { roots: [moved.originalPath], owner: config.host.id, sessionId: 'restored-checkout' }).state, 'reserved');
      } finally { afterRestore.close(); }
      assert.equal(git(moved.originalPath, 'rev-parse', 'HEAD'), other.head);
      assert.equal(git(moved.originalPath, 'symbolic-ref', 'HEAD'), other.branch);
      assert.deepEqual(fs.readFileSync(path.join(moved.originalPath, tracked)), bytes);
      assert.equal(fs.readFileSync(path.join(moved.originalPath, unique), 'utf8'), 'additional data');
      assert.equal(git(selected.path, 'rev-parse', 'HEAD'), selected.head);
    } finally { recovering.close(); }
  } finally { store.close(); }
});

async function worktreePurgeFixture(t) {
  let store;
  t.after(() => store?.close());
  const f = worktreeFixture(t);
  store = f.store;
  const { config, project, read, accept } = f;
  await accept(7);
  const select = decision => {
    assert.equal(decision?.status, 'eligible', JSON.stringify(decision));
    store.transaction(tx => tx.put('decision', decision.id, { version: 1, ...decision, policyGeneration: config.generation }));
    return decision;
  };
  const selected = select(scanProject(config, store, project).decisions.find(decision => decision.branch === 'refs/heads/agent-7'));
  const moved = await moveWorktreeToQuarantine(config, store, selected.id, read);
  const locked = await lockWorktreeQuarantine(config, store, moved.id);
  await until(() => retentionStatus(locked.retentionClock, sampleClock(), config.policy.retentionMs) === null);
  const reviewed = select(inspectWorktreeQuarantine(config, store, locked.id));
  return { ...f, selected, locked, reviewed };
}

test('quarantined worktree review binds retention, contents and owned lock', { skip: process.platform !== 'win32', timeout: 120000 }, async t => {
  const { s, config, store, read, selected, locked, reviewed } = await worktreePurgeFixture(t);
  const clock = locked.retentionClock;
  const review = sample => inspectWorktreeQuarantine(config, store, locked.id, sample);
  assert.deepEqual(review(clock).reasons, ['retention_pending']);
  assert.deepEqual(review({ ...clock, wallMs: clock.wallMs + 60000 }).reasons, ['retention_clock_uncertain']);
  assert.equal(reviewed.evidence.worktree.taskEvidence.acceptanceId, selected.evidence.taskEvidence.acceptanceId);
  await syncGitHubIssue(config, store, 'issues', locked.issue, read);
  assert.equal(review().id, reviewed.id);
  const newRef = 'refs/remotes/fixture/unrelated';
  git(s.root, 'update-ref', newRef, selected.head);
  try {
    const changed = review();
    assert.equal(changed.evidence.worktree.integration, reviewed.evidence.worktree.integration);
    assert.notEqual(changed.id, reviewed.id);
  } finally { git(s.root, 'update-ref', '-d', newRef); }
  const extraDirectory = path.join(locked.payloadPath, 'unrecorded-directory');
  fs.mkdirSync(extraDirectory);
  try { assert.ok(review().reasons.includes('quarantine_baseline_changed_or_unknown')); }
  finally { fs.rmdirSync(extraDirectory); }
  assert.equal(review().id, reviewed.id);
  assert.equal(store.get('action', locked.id).value.phase, 'quarantined');

  const lock = path.join(locked.command.gitDir, 'locked');
  const lockBytes = fs.readFileSync(lock);
  const oldLock = `${lock}.original`;
  fs.renameSync(lock, oldLock);
  fs.writeFileSync(lock, lockBytes);
  try { assert.match(review().error, /lock incarnation changed/); }
  finally {
    fs.unlinkSync(lock);
    fs.renameSync(oldLock, lock);
  }
  assert.deepEqual(fs.readFileSync(lock), lockBytes);
});

test('pending worktree purge fences the repository and rejects changed issue authority', { skip: process.platform !== 'win32', timeout: 120000 }, async t => {
  const { s, config, store, read, fixtures, locked, reviewed } = await worktreePurgeFixture(t);
  const verify = revision => store.transaction(tx => verifyWorktreePurge(config, tx, locked.id, revision));
  const lock = path.join(locked.command.gitDir, 'locked');
  const lockBytes = fs.readFileSync(lock);
  const producer = () => reserve(store, { roots: [s.root], owner: config.host.id, sessionId: 'purge-sibling' });
  const sibling = producer();
  assert.throws(() => beginWorktreePurge(config, store, reviewed.id), /owner\/cleanup claim/);
  assert.equal(store.get('action', locked.id).value.phase, 'quarantined');
  const job = { kind: 'windows_job', launchToken: sibling.token, helperPid: 1, activeProcesses: null };
  transition(store, sibling.token, 'reserved', 'starting');
  transition(store, sibling.token, 'starting', 'running', job);
  transition(store, sibling.token, 'running', 'ended', { ...job, activeProcesses: 1 });

  const intent = beginWorktreePurge(config, store, reviewed.id);
  assert.equal(intent.phase, 'purge_pending');
  assert.throws(() => producer(), /Cleanup claim/);
  assert.throws(() => verify(intent.purgeIntent.initialIssueRevision), /snapshot superseded/);
  const refresh = (request = read) => refreshWorktreePurgeAuthority(config, store, locked.id, request);
  const revision = await refresh();
  assert.equal(verify(revision).id, reviewed.id);
  const later = await refresh();
  assert.throws(() => verify(revision), /snapshot superseded/);
  const extra = path.join(locked.payloadPath, 'after-review');
  fs.mkdirSync(extra);
  try { assert.throws(() => verify(later), /quarantine_baseline_changed_or_unknown/); }
  finally { fs.rmdirSync(extra); }
  const cancelled = await refresh(endpoint => {
    if (endpoint.includes('/timeline?')) assert.equal(reconcile(config, store, locked.id).phase, 'quarantined');
    return read(endpoint);
  });
  assert.throws(() => verify(cancelled), /pending worktree purge/);
  assert.equal(store.get('claim', locked.claimToken).value.state, 'held');
  assert.deepEqual(fs.readFileSync(lock), lockBytes);

  beginWorktreePurge(config, store, reviewed.id);
  const [approval] = fixtures.get(7);
  const at = Date.parse(approval.created_at) + 1000;
  await until(() => Date.now() >= at);
  fixtures.set(7, [approval, { event: 'reopened', id: 105, created_at: new Date(at).toISOString().replace('.000Z', 'Z') }]);
  const reopened = await refresh();
  assert.throws(() => verify(reopened), /issue_reopened/);
  assert.equal(reconcile(config, store, locked.id).phase, 'quarantined');
  assert.equal(fs.existsSync(locked.payloadPath), true);
  assert.deepEqual(fs.readFileSync(lock), lockBytes);
  assert.ok(inspectWorktreeQuarantine(config, store, locked.id).reasons.includes('issue_reopened'));
  assert.throws(() => beginWorktreePurge(config, store, reviewed.id), /issue_reopened/);
  assert.equal(producer().state, 'reserved');
});

test('selected worktree purge retains its branch and reconciles only the verified native outcome', { skip: process.platform !== 'win32', timeout: 120000 }, async t => {
  const { s, config, store, read, locked, reviewed, selected } = await worktreePurgeFixture(t);
  const missingSibling = path.join(s.base, 'missing-sibling');
  git(s.root, 'worktree', 'add', '-b', 'missing-sibling', missingSibling);
  fs.renameSync(missingSibling, path.join(s.base, 'offline-sibling'));
  await assert.rejects(purgeWorktree(config, store, reviewed.id, () => assert.fail('Stale decision reached GitHub')), /purge decision changed/);
  const current = inspectWorktreeQuarantine(config, store, locked.id);
  assert.equal(current.status, 'eligible', JSON.stringify(current));
  store.transaction(tx => tx.put('decision', current.id, { version: 1, ...current, policyGeneration: config.generation }));
  const trash = path.join(s.gitDir, 'wt', 'trash'), unrelated = path.join(trash, 'controller-unrelated.pending');
  fs.mkdirSync(unrelated, { recursive: true });
  const sentinel = path.join(unrelated, 'sentinel');
  fs.writeFileSync(sentinel, 'keep this trash');
  const refs = git(s.root, 'show-ref');
  store.db.exec("CREATE TRIGGER fail_purge BEFORE INSERT ON records WHEN NEW.kind='action' AND json_extract(NEW.body,'$.phase')='purged' BEGIN SELECT RAISE(ABORT,'injected purge completion failure'); END;");
  await assert.rejects(purgeWorktree(config, store, current.id, read), /purge completion failure/);
  store.db.exec('DROP TRIGGER fail_purge');
  const purging = store.get('action', locked.id).value;
  assert.equal(purging.phase, 'purging');
  assert.equal(readCommandCompletion(config, purging.purgeCommand.launch).exitCode, 0);
  assert.equal(fs.existsSync(locked.payloadPath), false);
  assert.equal(fs.existsSync(locked.originalPath), false);
  assert.equal(fs.existsSync(locked.command.gitDir), false);
  assert.equal(git(s.root, 'rev-parse', selected.branch), selected.head);
  assert.equal(git(s.root, 'show-ref'), refs);
  assert.ok(git(s.root, 'worktree', 'list', '--porcelain').includes('branch refs/heads/missing-sibling'));
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep this trash');
  assert.deepEqual(fs.readdirSync(trash), ['controller-unrelated.pending']);
  const producer = () => reserve(store, { roots: [s.root], owner: config.host.id, sessionId: 'purge-recovery' });
  assert.throws(producer, /Cleanup claim/);
  const receipt = path.join(config.stateDir, `${purging.purgeCommand.launch.evidence.launchToken}.native-completion`);
  fs.renameSync(receipt, `${receipt}.held`);
  try { assert.throws(() => reconcile(config, store, locked.id), /Native worktree purge completion unavailable/); }
  finally { fs.renameSync(`${receipt}.held`, receipt); }
  const partial = path.join(trash, 'controller-partial.pending');
  fs.mkdirSync(partial);
  try { assert.throws(() => reconcile(config, store, locked.id), /staging outcome unavailable/); }
  finally { fs.rmdirSync(partial); }
  git(s.root, 'update-ref', selected.branch, '0000000000000000000000000000000000000000', selected.head);
  try { assert.throws(() => reconcile(config, store, locked.id), /repository or staging outcome unavailable/); }
  finally { git(s.root, 'update-ref', selected.branch, selected.head); }
  assert.equal(store.get('claim', locked.claimToken).value.state, 'held');
  const restarted = new Store(config.stateDir);
  try {
    const purged = reconcile(config, restarted, locked.id);
    assert.equal(purged.phase, 'purged');
    assert.equal(purged.purgeOutcome, 'complete');
    assert.deepEqual(reconcile(config, restarted, locked.id), purged);
    assert.equal(restarted.get('claim', locked.claimToken).value.state, 'released');
  } finally { restarted.close(); }
  assert.equal(producer().state, 'reserved');
});

test('native worktree purge refuses a configured project hook and leaves the checkout restorable', { skip: process.platform !== 'win32', timeout: 120000 }, async t => {
  const { s, tracked, config, store, read, locked, reviewed, selected } = await worktreePurgeFixture(t);
  const override = 'WORKTRUNK_PRE-REMOVE', before = process.env[override];
  process.env[override] = 'echo unsafe';
  try { await assert.rejects(purgeWorktree(config, store, reviewed.id, read), /refuses inherited Worktrunk configuration overrides/); }
  finally { if (before === undefined) delete process.env[override]; else process.env[override] = before; }
  assert.equal(store.get('action', locked.id).value.phase, 'quarantined');
  const projectConfig = path.join(s.root, '.config');
  fs.mkdirSync(projectConfig);
  fs.writeFileSync(path.join(projectConfig, 'wt.toml'), 'pre-remove = "echo unsafe > hook-ran.txt"\n');
  await assert.rejects(purgeWorktree(config, store, reviewed.id, read), /Native Worktrunk refused purge/);
  const refused = store.get('action', locked.id).value;
  assert.equal(refused.phase, 'unlocked');
  assert.notEqual(refused.purgeCommand.exitCode, 0);
  assert.equal(store.get('claim', locked.claimToken).value.state, 'held');
  assert.equal(fs.readFileSync(path.join(locked.payloadPath, tracked), 'utf8'), 'committed checkout data');
  assert.equal(fs.existsSync(path.join(locked.payloadPath, 'hook-ran.txt')), false);
  assert.equal(fs.existsSync(path.join(s.root, 'hook-ran.txt')), false);
  assert.equal((await restoreWorktree(config, store, locked.id)).phase, 'restored');
  assert.equal(git(locked.originalPath, 'rev-parse', 'HEAD'), selected.head);
  assert.equal(fs.readFileSync(path.join(locked.originalPath, tracked), 'utf8'), 'committed checkout data');
});

function setup(t) {
  let store;
  const root = fixture(t, () => store?.close()), state = path.join(root, 'state');
  store = new Store(state);
  const config = { stateDir: state, nativeHost: { path: host, sha256: createHash('sha256').update(fs.readFileSync(host)).digest('hex'), version: 1 }, host: { id: 'test-host' }, limits: { timeoutMs: 5000 } };
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

test('journaled native command waits for durable authorization', { skip: process.platform !== 'win32' }, async t => {
  const s = setup(t), sentinel = path.join(s.root, 'never');
  const request = { root: s.root, program: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'bad');`] };
  s.store.db.exec("CREATE TRIGGER fail_command BEFORE INSERT ON records WHEN NEW.kind='action_command' BEGIN SELECT RAISE(ABORT,'injected authorization failure'); END;");
  await assert.rejects(runJournaledCommand(s.config, s.store, request, (tx, launch) =>
    tx.put('action_command', 'fixture', { version: 1, launch })), /authorization failure/);
  assert.equal(fs.existsSync(sentinel), false);
  assert.equal(s.store.get('action_command', 'fixture'), null);
  assert.equal(fs.readdirSync(s.state).some(name => name.endsWith('.native-completion')), false);
});

test('journaled native completion survives controller death and proves descendant exit', { skip: process.platform !== 'win32' }, async t => {
  const s = setup(t), ready = path.join(s.root, 'ready'), gate = path.join(s.root, 'gate');
  const descendant = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(ready)}, 'ready');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)}))clearInterval(timer);},20);`;
  const program = `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:'ignore'});c.unref();process.exitCode=23;`;
  const request = { root: s.root, program: process.execPath, args: ['-e', program] };
  const worker = fileURLToPath(new URL('./fixtures/managed-worker.mjs', import.meta.url));
  const parent = spawn(process.execPath, [worker, s.state, JSON.stringify(s.config), JSON.stringify(request), 'journaled'], { stdio: 'ignore', windowsHide: true });
  const exited = once(parent, 'exit');
  let launch;
  try {
    await until(() => fs.existsSync(ready));
    assert.ok(parent.kill());
    await exited;
    const restarted = new Store(s.state);
    try { launch = restarted.get('action_command', 'fixture').value.launch; }
    finally { restarted.close(); }
    assert.equal(readCommandCompletion(s.config, launch), null);
    fs.writeFileSync(gate, 'finish');
    let receipt;
    await until(() => (receipt = readCommandCompletion(s.config, launch)) !== null);
    assert.equal(receipt.evidence.activeProcesses, 1);
    assert.equal(receipt.exitCode, 23);
    assert.throws(() => readCommandCompletion(s.config, { ...launch, evidence: { ...launch.evidence, helperPid: launch.evidence.helperPid + 1 } }), /does not match authorization/);
    assert.throws(() => readCommandCompletion(s.config, { ...launch, stateIdentity: {} }), /state boundary changed/);
  } finally {
    if (!fs.existsSync(gate)) fs.writeFileSync(gate, 'finish');
    if (parent.exitCode === null && parent.signalCode === null) parent.kill();
    await exited;
    if (launch) await until(() => readCommandCompletion(s.config, launch) !== null);
  }
});

test('journaled native command can finish after the controller wait times out', { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
  const s = setup(t), ready = path.join(s.root, 'ready'), gate = path.join(s.root, 'gate');
  s.config.limits.timeoutMs = 2500;
  const code = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(ready)}, 'ready');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)}))clearInterval(timer);},20);`;
  const open = () => fs.writeFileSync(gate, 'finish');
  t.signal.addEventListener('abort', open, { once: true });
  try {
    await assert.rejects(runJournaledCommand(s.config, s.store, { root: s.root, program: process.execPath, args: ['-e', code] },
      (tx, launch) => tx.put('action_command', 'fixture', { version: 1, launch })), /completion unavailable/);
    const { launch } = s.store.get('action_command', 'fixture').value;
    assert.equal(fs.existsSync(ready), true);
    assert.equal(readCommandCompletion(s.config, launch), null);
    open();
    let receipt;
    await until(() => (receipt = readCommandCompletion(s.config, launch)) !== null);
    assert.equal(receipt.exitCode, 0);
  } finally { t.signal.removeEventListener('abort', open); open(); }
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
