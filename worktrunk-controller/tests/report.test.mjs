import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { ingest } from '../lib/events.mjs';
import { report } from '../lib/report.mjs';
import { fixture } from './helpers.mjs';

const sources = [
  { id: 'host', instance: 'host-1', role: 'host', projects: ['p', 'q'], authority: null },
  { id: 'other-host', instance: 'host-2', role: 'host', projects: ['p'], authority: null },
  { id: 'tasks', instance: 'tasks-1', role: 'task', projects: ['p', 'q'], authority: 'tracker' },
];
const config = { eventSources: sources, projects: [{ id: 'p' }, { id: 'q' }], generation: 'policy' };
const base = Date.parse('2026-11-02T00:00:00Z'), day = 86400000;
function timeline(t) {
  let store;
  store = new Store(path.join(fixture(t, () => store?.close()), 'state'));
  let n = 0;
  const add = (source, type, at, fields = {}) => {
    const payload = { version: 1, eventId: `e${++n}`, project: 'p', type, at: at === null ? null : base + at, ...fields };
    ingest(config, store, source, payload, base + 10 * day);
    return payload;
  };
  const read = () => report(config, store, { from: base, to: base + 14 * day, now: base + 14 * day });
  return { store, add, read };
}

test('weekly distinct tasks, first-attempt cancellations, retries and accepted cohort durations are exact after replay', t => {
  const { store, add, read } = timeline(t);
  const task = (type, at, taskId, fields = {}) => add('tasks', type, at, { taskId, authorityProject: 'project-p', ...fields });
  task('task_started', 0, '1');
  task('attempt_started', 0, '1', { attemptId: 'a', attemptNumber: 1, worktreeId: 'old' });
  const accepted = task('attempt_accepted', 1000, '1', { attemptId: 'a', attemptNumber: 1, agentIds: ['agent-a'], worktreeId: 'moved' });
  task('attempt_accepted', 2000, '1', { attemptId: 'a', attemptNumber: 1, agentIds: ['agent-a'] });
  task('task_reopened', 3000, '1'); task('task_revoked', 4000, '1');
  task('task_started', 0, '2');
  task('attempt_started', 0, '2', { attemptId: 'b', attemptNumber: 1 });
  task('attempt_failed', 1000, '2', { attemptId: 'b', attemptNumber: 1 });
  task('attempt_started', 7 * day, '2', { attemptId: 'c', attemptNumber: 2, worktreeId: 'other' });
  task('attempt_accepted', 7 * day + 3000, '2', { attemptId: 'c', attemptNumber: 2, agentIds: ['agent-b', 'agent-c'] });
  task('attempt_cancelled', 2000, '3', { attemptId: 'd', attemptNumber: 1 });
  task('task_started', 0, '1', { project: 'q', authorityProject: 'project-q' });
  task('attempt_accepted', 3000, '1', { project: 'q', authorityProject: 'project-q', attemptId: 'a', attemptNumber: 1 });
  const before = read();
  ingest(config, store, 'tasks', accepted, base + 20 * day);
  assert.deepEqual(read(), before);
  assert.equal(before.observedFirstAcceptedTasks, 3);
  assert.deepEqual(before.weeks, [{ week: '2026-11-02', observedFirstAcceptedTasks: 2 }, { week: '2026-11-09', observedFirstAcceptedTasks: 1 }]);
  assert.deepEqual(before.firstAttemptOutcomes, { accepted: 2, failed: 1, cancelled: 1, total: 4, acceptanceRate: 0.5, unavailableTasks: 0 });
  assert.deepEqual(before.acceptedTaskDuration, { samples: 3, unavailable: 0, medianMs: 3000, p95Ms: 7 * day + 3000 });
  assert.deepEqual(before.attribution, { singleAgent: { 'agent-a': 1 }, multipleAgents: 1, unavailable: 1 });
  assert.equal(before.tasks.find(task => task.taskId === '2').observedRetries, 1);
  assert.equal(before.tasks.find(task => task.taskId === '1' && task.project === 'p').currentOutcome, 'revoked');
  assert.equal(before.observedReopens, 1); assert.equal(before.observedRevocations, 1);
  assert.equal(before.coverage[0].status, 'partial_unmeasured');
});

test('out-of-order independent sessions retain moves, Stop waiting time and per-host overlap', t => {
  const { add, read } = timeline(t);
  add('host', 'session_ended', 30, { sessionId: 's', sequence: 4, worktreeId: 'moved' });
  add('host', 'working', 0, { sessionId: 's', sequence: 1, worktreeId: 'old' });
  add('host', 'working', 10, { sessionId: 't', sequence: 2 });
  add('host', 'waiting', 20, { sessionId: 's', sequence: 3, worktreeId: 'moved' });
  add('host', 'session_ended', 40, { sessionId: 't', sequence: 5 });
  add('host', 'working', 50, { sessionId: 'missing-end' });
  add('other-host', 'working', 0, { sessionId: 's' });
  add('other-host', 'association', 5, { sessionId: 's', worktreeId: 'detached' });
  add('other-host', 'session_ended', 40, { sessionId: 's', worktreeId: 'detached' });
  const result = read();
  assert.equal(result.sessions.length, 4);
  const s = result.sessions.find(session => session.sessionId === 's' && session.sourceInstance === 'host-1');
  assert.equal(s.currentState, 'ended'); assert.equal(s.worktreeId, 'moved');
  assert.equal(s.observedWorkingMs, 20); assert.equal(s.observedWaitingMs, 10);
  const open = result.sessions.find(session => session.sessionId === 'missing-end');
  assert.equal(open.currentState, 'unknown'); assert.equal(open.observedWorkingMs, null);
  assert.deepEqual(result.concurrency.find(host => host.instance === 'host-1'), { instance: 'host-1', observedOverlapMs: 20, maxObservedConcurrentSessions: 2 });
  const detached = result.sessions.find(session => session.sourceInstance === 'host-2');
  assert.equal(detached.observedWorkingMs, 40); assert.equal(detached.worktreeId, 'detached');
});

test('missing identities, ambiguous attempt ordinals and clocks leave metrics unavailable', t => {
  const { add, read } = timeline(t);
  add('tasks', 'attempt_accepted', 100, { attemptId: 'orphan', authorityProject: 'p' });
  add('host', 'waiting', 100);
  add('tasks', 'task_started', 200, { taskId: 'clock', authorityProject: 'p' });
  add('tasks', 'attempt_accepted', 100, { taskId: 'clock', authorityProject: 'p', attemptId: 'one', attemptNumber: 1 });
  add('tasks', 'attempt_accepted', null, { taskId: 'missing-time', authorityProject: 'p' });
  add('tasks', 'attempt_accepted', 100, { taskId: 'missing-ordinal', authorityProject: 'p', attemptId: 'one' });
  add('host', 'working', 200, { sessionId: 'clock', sequence: 1 });
  add('host', 'session_ended', 100, { sessionId: 'clock', sequence: 2 });
  const result = read();
  assert.equal(result.unassociatedTaskEvents, 1); assert.equal(result.unassociatedSessionEvents, 1);
  assert.equal(result.firstAttemptOutcomes.acceptanceRate, null);
  assert.equal(result.firstAttemptOutcomes.unavailableTasks, 3);
  assert.equal(result.acceptedTaskDuration.samples, 0);
  assert.equal(result.acceptedTaskDuration.medianMs, null);
  assert.equal(result.sessions[0].currentState, 'unknown');
  assert.equal(result.sessions[0].observedWorkingMs, null);
  assert.equal(result.artifactGrowthBytes, null); assert.equal(result.reclaimedBytes, null); assert.equal(result.usage, null);
});

test('acceptance is counted in its first UTC week even after a later repeated acceptance', t => {
  const { store, add } = timeline(t);
  add('tasks', 'attempt_accepted', -1, { taskId: 'old', authorityProject: 'p', attemptId: 'one', attemptNumber: 1 });
  add('tasks', 'attempt_accepted', 1, { taskId: 'old', authorityProject: 'p', attemptId: 'one', attemptNumber: 1 });
  const result = report(config, store, { from: base, to: base + day, now: base + 14 * day });
  assert.equal(result.observedFirstAcceptedTasks, 0);
  assert.equal(result.firstAttemptOutcomes.total, 0);
});

test('conflicting simultaneous states require explicit source ordering', t => {
  const { add, read } = timeline(t);
  for (const sessionId of ['a', 'b', 'ordered']) {
    const ordered = sessionId === 'ordered';
    add('host', 'working', 0, { sessionId, eventId: sessionId === 'b' ? 'z' : `${sessionId}-a`, ...(ordered ? { sequence: 1 } : {}) });
    add('host', 'waiting', 0, { sessionId, eventId: sessionId === 'b' ? 'b' : `${sessionId}-z`, ...(ordered ? { sequence: 2 } : {}) });
    add('host', 'session_ended', 50, { sessionId, ...(ordered ? { sequence: 3 } : {}) });
  }
  const result = read();
  for (const session of result.sessions.filter(row => row.sessionId !== 'ordered')) {
    assert.equal(session.durationStatus, 'unavailable');
    assert.equal(session.observedWorkingMs, null); assert.equal(session.observedWaitingMs, null);
  }
  assert.equal(result.sessions.find(row => row.sessionId === 'ordered').observedWaitingMs, 50);
});

test('source gaps invalidate crossed durations while other sessions account for known sequences', t => {
  const { store, add, read } = timeline(t);
  add('host', 'working', 0, { sessionId: 'gap', sequence: 1 });
  add('host', 'session_ended', 50, { sessionId: 'gap', sequence: 3 });
  add('host', 'working', 60, { sessionId: 'known', sequence: 4 });
  add('host', 'working', 70, { sessionId: 'other', project: 'q', sequence: 5 });
  add('host', 'session_ended', 80, { sessionId: 'known', sequence: 6 });
  const result = read();
  const gap = result.sessions.find(row => row.sessionId === 'gap');
  assert.equal(gap.observedWorkingMs, null); assert.equal(gap.durationStatus, 'unavailable');
  assert.deepEqual(gap.intervals, []);
  assert.equal(result.sessions.find(row => row.sessionId === 'known').observedWorkingMs, 20);
  const filtered = report({ ...config, projects: [{ id: 'p' }] }, store, { from: base, to: base + day, now: base + 14 * day });
  assert.equal(filtered.sessions.find(row => row.sessionId === 'known').observedWorkingMs, 20);
});

test('state-only events preserve the last explicit repository and worktree association', t => {
  const { add, read } = timeline(t);
  add('host', 'association', 0, { sessionId: 's', repositoryId: 'repo', worktreeId: 'old' });
  add('host', 'working', 1, { sessionId: 's' });
  add('host', 'association', 2, { sessionId: 's', worktreeId: 'moved' });
  add('host', 'session_ended', 3, { sessionId: 's' });
  const session = read().sessions[0];
  assert.equal(session.repositoryId, 'repo'); assert.equal(session.worktreeId, 'moved');
});

test('purge report counts completed owned actions once in the exact window without mutating evidence', t => {
  const { store } = timeline(t);
  const scoped = { ...config, host: { id: 'owner' }, projects: [{ id: 'p' }] };
  const put = (id, fields = {}) => store.transaction(tx => tx.put('action', id, { version: 1, id, kind: 'artifact', owner: 'owner', projects: ['p', 'q'], artifactId: 'shared', phase: 'purged', purgeOutcome: 'complete', createdAt: base - 20, quarantinedAt: base - 10, purgedAt: base, baseline: { contents: { logicalBytes: 7 } }, ...fields }));
  put('first'); put('second', { purgedAt: base + 1 });
  put('before', { purgedAt: base - 1 }); put('end', { purgedAt: base + day });
  put('other-owner', { owner: 'other' }); put('other-project', { projects: ['q'] });
  put('pending', { phase: 'purging' }); put('interrupted', { phase: 'restored', purgeOutcome: 'interrupted' });
  put('worktree', { kind: 'worktree', project: 'p' });
  put('other-worktree', { kind: 'worktree', project: 'q' });
  const read = () => report(scoped, store, { from: base, to: base + day, now: base + 2 * day });
  const evidence = store.list('action');
  assert.deepEqual(read().actions.filter(action => action.kind === 'worktree').map(action => [action.id, action.project]), [['worktree', 'p']]);
  assert.deepEqual(read().artifactPurges, { observedActions: 2, logicalBytes: 14, unavailableTimeActions: 0 });
  assert.deepEqual(read().artifactPurges, read().artifactPurges);
  assert.deepEqual(store.list('action'), evidence);
  for (const [id, purgedAt] of [['recovered', null], ['missing', null], ['future', base + 3 * day], ['reversed', base - 11], ['invalid', 'today']]) put(id, { purgedAt });
  store.transaction(tx => {
    const { purgedAt, ...missing } = tx.get('action', 'missing').value;
    tx.put('action', 'missing', missing);
  });
  assert.deepEqual(read().artifactPurges, { observedActions: 2, logicalBytes: 14, unavailableTimeActions: 5 });
  assert.equal(read().reclaimedBytes, null);
});

test('purge bytes stay unavailable for missing or invalid baselines and unsafe totals', t => {
  const { store } = timeline(t), scoped = { ...config, host: { id: 'owner' } };
  const action = { version: 1, kind: 'artifact', owner: 'owner', projects: ['p'], phase: 'purged', purgeOutcome: 'complete', createdAt: base - 2, quarantinedAt: base - 1, purgedAt: base };
  const read = () => report(scoped, store, { from: base, to: base + day, now: base + day }).artifactPurges;
  assert.deepEqual(read(), { observedActions: 0, logicalBytes: 0, unavailableTimeActions: 0 });
  for (const bytes of [undefined, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, { toString: null }]) {
    store.transaction(tx => tx.put('action', 'one', { ...action, baseline: { contents: bytes === undefined ? {} : { logicalBytes: bytes } } }));
    assert.deepEqual(read(), { observedActions: 1, logicalBytes: null, unavailableTimeActions: 0 });
  }
  for (const bytes of [0, Number.MAX_SAFE_INTEGER]) {
    store.transaction(tx => tx.put('action', 'one', { ...action, baseline: { contents: { logicalBytes: bytes } } }));
    assert.equal(read().logicalBytes, bytes);
  }
  store.transaction(tx => tx.put('action', 'two', { ...action, baseline: { contents: { logicalBytes: 1 } } }));
  assert.deepEqual(read(), { observedActions: 2, logicalBytes: null, unavailableTimeActions: 0 });
});
