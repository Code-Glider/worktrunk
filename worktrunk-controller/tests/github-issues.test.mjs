import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { digest } from '../lib/data.mjs';
import { loadConfig } from '../lib/config.mjs';
import { ingest, syncGitHubIssue } from '../lib/events.mjs';
import { report } from '../lib/report.mjs';
import { Store } from '../lib/store.mjs';
import { controller, fixture } from './helpers.mjs';

const head = 'a'.repeat(40);
const repository = 'owner/repo';
const repoPath = `repos/${repository}`;
const issuePath = `${repoPath}/issues/7`;
const timelinePath = `${issuePath}/timeline?per_page=100`;
const source = { id: 'github', instance: 'github-1', role: 'task', projects: ['myproject'], github: { repository, repositoryId: 22, acceptorIds: [5] } };
const issue = { id: 38, number: 7, repository_url: `https://api.github.com/${repoPath}` };
const repo = { id: 22, full_name: 'Owner/Repo' };
const start = '2026-01-02T01:00:00Z';
const reopened = { event: 'reopened', id: 44, created_at: '2026-01-02T02:00:00Z' };
const comment = { event: 'commented', id: 44, user: { type: 'User', id: 5 }, created_at: start, updated_at: start, body: `/worktrunk accept 1 ${head.toUpperCase()}` };

function setup(t) {
  const { filename } = controller(t, process.execPath);
  const raw = JSON.parse(fs.readFileSync(filename));
  raw.eventSources = [source];
  const load = () => {
    fs.writeFileSync(filename, JSON.stringify(raw));
    return loadConfig(filename);
  };
  const config = load();
  let store;
  store = new Store(path.join(fixture(t, () => store?.close()), 'state'));
  const request = values => async (endpoint, { paginate, timeout }) => {
    assert.equal(Boolean(paginate), endpoint === timelinePath);
    assert.equal(timeout, 10000);
    assert.ok(Object.hasOwn(values, endpoint), `Unexpected GitHub endpoint ${endpoint}`);
    return values[endpoint];
  };
  const sync = (pages, overrides = {}, settings = config) => syncGitHubIssue(settings, store, 'github', 7, request({ [repoPath]: repo, [issuePath]: issue, [timelinePath]: pages, ...overrides }));
  const read = (settings = config) => report(settings, store, { from: Date.parse('2026-01-01'), to: Date.parse('2026-01-03') });
  return { config, store, raw, load, sync, read };
}

test('syncs only explicit trusted acceptance, replays idempotently and reports native reopening', async t => {
  const { config, store, sync, read } = setup(t);
  const unrelated = [
    { event: 'closed', id: 1 },
    { ...comment, id: 2, user: { type: 'User', id: 6 } },
    { ...comment, id: 3, user: { type: 'Bot', id: 5 } },
    { ...comment, id: 4, updated_at: reopened.created_at },
    { ...comment, id: 5, body: `/worktrunk accept 1 ${head.slice(0, 12)}` },
    { ...comment, id: 6, body: `${comment.body}\n` },
  ];
  assert.throws(() => ingest(config, store, 'github', {}), /sync-github-issue/);
  assert.deepEqual(await sync([unrelated, [comment]]), { version: 1, source: 'github', issue: 7, taskId: '38', recorded: 1, replayed: 0 });
  assert.equal(read().tasks[0].currentOutcome, 'accepted');
  assert.equal(read().tasks[0].authorityProject, '22');
  assert.equal(store.list('event')[0].value.event.head, head);
  assert.ok(!JSON.stringify(store.list('event')).includes('/worktrunk accept'));
  assert.deepEqual(await sync([[comment, reopened]]), { version: 1, source: 'github', issue: 7, taskId: '38', recorded: 1, replayed: 1 });
  const result = read();
  assert.equal(result.tasks[0].currentOutcome, 'reopened');
  assert.equal(result.observedFirstAcceptedTasks, 1);
  assert.equal(result.observedReopens, 1);
  assert.equal(result.coverage[0].status, 'partial_unmeasured');
  assert.equal(result.acceptedTaskDuration.samples, 0);
});

test('a changed or deleted acceptance loses current status while preserving historical observations', async t => {
  const { config, sync, read } = setup(t);
  await sync([[comment]]);
  assert.equal(read().tasks[0].currentOutcome, 'accepted');
  assert.equal(read({ ...config, eventSources: [] }).tasks[0].currentOutcome, 'unknown');
  await sync([[{ ...comment, updated_at: reopened.created_at }]]);
  assert.equal(read().tasks[0].currentOutcome, 'unknown');
  assert.equal(read().observedFirstAcceptedTasks, 1);
  assert.ok(Number.isSafeInteger(read().tasks[0].authorityObservedAt));
  await sync([[]]);
  assert.equal(read().tasks[0].currentOutcome, 'unknown');
});

test('an ambiguous historical attempt can have a clear current outcome after deletion or reopening', async t => {
  const { sync, read } = setup(t);
  const conflicting = { ...comment, id: 45, body: `/worktrunk accept 1 ${'b'.repeat(40)}` };
  await sync([[comment, conflicting]]);
  assert.equal(read().tasks[0].currentOutcome, 'unknown');
  await sync([[comment]]);
  assert.equal(read().tasks[0].currentOutcome, 'accepted');
  assert.equal(read().tasks[0].firstAttempt, null);
  await sync([[comment, conflicting, reopened]]);
  assert.equal(read().tasks[0].currentOutcome, 'reopened');
  assert.equal(read().tasks[0].firstAttempt, null);
});

test('a late response cannot overwrite a concurrently committed issue snapshot', async t => {
  const { store, sync, read } = setup(t);
  const page = Promise.withResolvers();
  const pending = assert.rejects(sync(page.promise), /concurrent GitHub issue sync/);
  try { await sync([[reopened]]); }
  finally { page.resolve([[comment]]); }
  await pending;
  assert.equal(read().tasks[0].currentOutcome, 'reopened');
  assert.equal(store.list('event').length, 1);
});

test('throughput uses only matching ended launches and keeps GitHub authoritative', async t => {
  const { store, sync, read } = setup(t);
  const acceptedAt = Date.parse(start);
  function launch(attempt, changes = {}) {
    const token = `claim-${attempt}`;
    const task = { taskKey: digest(['github.com/issues', '22', '38']), sourceInstance: source.instance, project: 'myproject', issue: 7, taskId: '38', authorityProject: '22', attempt, agentId: 'agent-a', worktreeId: 'worktree-1' };
    store.transaction(tx => tx.put('claim', token, { version: 1, token, kind: 'producer', state: 'ended', task, admittedAt: acceptedAt - 5000 + 1000 * attempt, endedAt: acceptedAt - 1000, endedHead: head, evidence: { kind: 'windows_job', launchToken: token, activeProcesses: 1 }, ...changes }));
  }
  const retry = { ...comment, body: `/worktrunk accept 2 ${head}` };
  launch(2, { state: 'unresolved' });
  await sync([[retry]]);
  assert.equal(read().observedFirstAcceptedTasks, 1);
  assert.equal(read().tasks[0].attribution, 'unavailable');
  assert.equal(read().tasks[0].attempts[0].managed, undefined);
  launch(2, { endedHead: 'b'.repeat(40) });
  assert.equal(read().tasks[0].attribution, 'unavailable');
  launch(2, { endedAt: acceptedAt + 1 });
  assert.equal(read().tasks[0].attribution, 'unavailable');
  launch(2);
  assert.deepEqual(read().tasks[0].agentIds, ['agent-a']);
  assert.equal(read().tasks[0].durationMs, null);
  launch(1, { endedAt: acceptedAt - 3500 });
  const result = read();
  assert.equal(result.tasks[0].durationMs, 4000);
  assert.equal(result.tasks[0].observedRetries, 1);
  assert.equal(result.tasks[0].attempts[0].terminal, null);
  assert.equal(result.firstAttemptOutcomes.total, 0);
  assert.equal(result.acceptedTaskDuration.samples, 1);
  assert.equal(result.attribution.singleAgent['agent-a'], 1);
  assert.equal(result.coverage[0].status, 'partial_unmeasured');
  await sync([[retry, { ...comment, id: 45 }]]);
  assert.equal(read().tasks[0].attribution, 'unavailable');
  assert.equal(read().tasks[0].durationMs, null);
  await sync([[retry, reopened]]);
  assert.equal(read().tasks[0].currentOutcome, 'reopened');
  assert.equal(read().worktreeApplyEnabled, false);
});

test('wrong repository, pull request, malformed pages and conflicting replay leave evidence intact', async t => {
  const { raw, load, store, sync, read } = setup(t);
  await assert.rejects(sync([[comment]], { [repoPath]: { ...repo, id: 23 } }), /repository identity changed/);
  await assert.rejects(sync([[comment]], { [issuePath]: { ...issue, pull_request: {} } }), /does not match/);
  await assert.rejects(sync([[comment], null]), /Invalid GitHub issue timeline/);
  assert.deepEqual(store.list('event'), []);
  await sync([[comment]]);
  await assert.rejects(sync([[reopened, { ...comment, body: `/worktrunk accept 2 ${head}` }]]), /Conflicting event replay/);
  assert.equal(store.list('event').length, 1);
  assert.equal(read().tasks[0].currentOutcome, 'accepted');
  raw.eventSources = [{ ...source, github: { ...source.github, acceptorIds: [6] } }];
  const changed = load();
  assert.equal(read(changed).tasks[0].currentOutcome, 'unknown');
  await assert.rejects(sync([[]], {}, changed), /Source binding changed/);
  raw.eventSources = [{ ...source, github: undefined, authority: 'github.com/issues' }];
  assert.throws(load, /Use a GitHub issue source/);
});
