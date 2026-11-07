import { digest, integer, object, stable, text } from './data.mjs';
import { fetchIssueEvents, githubGet } from './github-issues.mjs';

const hostTypes = new Set(['session_started', 'working', 'waiting', 'session_ended', 'association']);
const taskTypes = new Set(['task_started', 'attempt_started', 'attempt_accepted', 'attempt_failed', 'attempt_cancelled', 'task_reopened', 'task_revoked']);
const fields = new Set(['version', 'eventId', 'type', 'project', 'at', 'sequence', 'sessionId', 'taskId', 'attemptId', 'attemptNumber', 'authorityProject', 'agentIds', 'repositoryId', 'worktreeId', 'head', 'fromSequence', 'throughSequence']);

// A source binding is immutable. Only configured task authorities can assert outcomes;
// recording commits once, before acknowledgment, and retains no raw host payloads.
export function ingest(config, store, sourceId, payload, observedAt = Date.now()) {
  const source = config.eventSources.find(source => source.id === sourceId);
  if (!source) throw new Error('Unconfigured event source');
  if (source.github) throw new Error('Use sync-github-issue for a GitHub issue source');
  return store.transaction(tx => recordEvent(tx, source, payload, observedAt));
}

export async function syncGitHubIssue(config, store, sourceId, issueNumber, request = githubGet) {
  return (await syncGitHubIssueSnapshot(config, store, sourceId, issueNumber, request)).result;
}

export async function syncKnownGitHubIssues(config, store, request = githubGet) {
  const sources = new Map(config.eventSources.filter(source => source.github)
    .map(source => [source.instance, { id: source.id, issues: new Set() }]));
  const addIssue = (instance, issue) => {
    if (Number.isSafeInteger(issue) && issue > 0) sources.get(instance)?.issues.add(issue);
  };
  for (const { value } of store.list('github_issue')) addIssue(value.sourceInstance, value.issue);
  for (const { value } of store.list('claim')) {
    if (value.kind === 'producer' && value.task) addIssue(value.task.sourceInstance, value.task.issue);
  }
  const synced = [], failed = [];
  for (const { id, issues } of sources.values()) {
    for (const issue of [...issues].sort((a, b) => a - b)) {
      try { synced.push(await syncGitHubIssue(config, store, id, issue, request)); }
      catch (error) { failed.push({ source: id, issue, error: error.message }); }
    }
  }
  return { version: 1, synced, failed };
}

export async function syncGitHubIssueSnapshot(config, store, sourceId, issueNumber, request = githubGet) {
  const source = config.eventSources.find(source => source.id === sourceId);
  if (!source?.github) throw new Error('Select a configured GitHub issue source');
  integer(issueNumber, 'GitHub issue number', 1);
  const key = digest([source.instance, issueNumber]);
  const revision = store.get('github_issue', key)?.revision;
  const readStartedAt = Date.now();
  const { taskId, authorityProject, events } = await fetchIssueEvents(source, issueNumber, config.limits.timeoutMs, request);
  const observedAt = Date.now();
  const taskKey = digest([source.authority, authorityProject, taskId]);
  const acceptances = events.filter(event => event.type === 'attempt_accepted').map(event => event.eventId).sort();
  return store.transaction(tx => {
    const binding = tx.get('event_source', source.instance)?.value;
    if (binding && digest(binding.source) !== digest(source)) throw new Error('Source binding changed; use a new instance');
    if (tx.get('github_issue', key)?.revision !== revision) throw new Error('A concurrent GitHub issue sync superseded this read');
    const results = events.map(event => recordEvent(tx, source, event, observedAt));
    if (!binding && !events.length) tx.put('event_source', source.instance, { version: 1, source });
    const issueRevision = tx.put('github_issue', key, { version: 1, sourceInstance: source.instance, issue: issueNumber, taskKey, readStartedAt, observedAt, acceptances });
    return { issueRevision, result: { version: 1, source: source.id, issue: issueNumber, taskId, recorded: results.filter(result => !result.replay).length, replayed: results.filter(result => result.replay).length } };
  });
}

function recordEvent(tx, source, payload, observedAt) {
  object(payload, 'event');
  if (payload.version !== 1) throw new Error('Unsupported event schema');
  if (Object.keys(payload).some(key => !fields.has(key)) || stable(payload).length > 65536) throw new Error('Unsupported/oversized event fields');
  text(payload.eventId, 'eventId'); text(payload.type, 'event type');
  if (!source.projects.includes(payload.project)) throw new Error('Event project is outside source authority');
  if (payload.type !== 'checkpoint' && !(source.role === 'host' ? hostTypes : taskTypes).has(payload.type)) throw new Error('Event type is outside source authority');
  const event = { version: 1, eventId: payload.eventId, type: payload.type, project: payload.project, sourceInstance: source.instance, sourceRole: source.role, authority: source.authority, at: payload.at ?? null, sequence: payload.sequence ?? null };
  if (event.at !== null) {
    integer(event.at, 'event at');
    if (!Number.isFinite(new Date(event.at).getTime())) throw new Error('Invalid event timestamp');
  }
  if (event.sequence !== null) integer(event.sequence, 'event sequence', 1);
  for (const field of ['sessionId', 'taskId', 'attemptId', 'authorityProject', 'repositoryId', 'worktreeId', 'head']) event[field] = payload[field] === undefined ? null : text(payload[field], field);
  event.attemptNumber = payload.attemptNumber ?? null;
  if (event.attemptNumber !== null) integer(event.attemptNumber, 'attemptNumber', 1);
  if (payload.agentIds !== undefined && (!Array.isArray(payload.agentIds) || payload.agentIds.some(id => !text(id, 'agentId')))) throw new Error('Invalid agentIds');
  event.agentIds = [...new Set(payload.agentIds ?? [])].sort();
  event.fromSequence = null; event.throughSequence = null;
  if (event.type === 'checkpoint') {
    event.fromSequence = integer(payload.fromSequence, 'fromSequence', 1);
    event.throughSequence = integer(payload.throughSequence, 'throughSequence', event.fromSequence);
    if (event.sequence !== null) throw new Error('Checkpoint cannot occupy a source event sequence');
  } else if (payload.fromSequence !== undefined || payload.throughSequence !== undefined) throw new Error('Sequence ranges require an independent checkpoint');
  integer(observedAt, 'observedAt');
  const id = digest([source.instance, event.eventId]);
  const binding = tx.get('event_source', source.instance)?.value;
  if (binding && digest(binding.source) !== digest(source)) throw new Error('Source binding changed; use a new instance');
  const old = tx.get('event', id)?.value;
  if (old) {
    if (digest(old.event) !== digest(event)) throw new Error('Conflicting event replay');
    return { version: 1, id, replay: true };
  }
  if (event.sequence !== null && tx.list('event').some(row => row.value.event.sourceInstance === source.instance && row.value.event.sequence === event.sequence)) throw new Error('Conflicting source sequence');
  if (!binding) tx.put('event_source', source.instance, { version: 1, source });
  tx.put('event', id, { version: 1, event, observedAt });
  return { version: 1, id, replay: false };
}

export function sourceCoverage(source, events) {
  const rows = events.filter(event => event.sourceInstance === source.instance);
  const sequences = rows.filter(event => event.type !== 'checkpoint' && event.sequence !== null).map(event => event.sequence).sort((a, b) => a - b);
  const checkpoints = rows.filter(event => event.type === 'checkpoint').map(event => {
    const missing = [];
    let next = event.fromSequence;
    for (const sequence of sequences) {
      if (sequence < next || sequence > event.throughSequence) continue;
      if (sequence > next) missing.push([next, sequence - 1]);
      next = sequence + 1;
    }
    if (next <= event.throughSequence) missing.push([next, event.throughSequence]);
    return { from: event.fromSequence, through: event.throughSequence, missing, status: missing.length ? 'gaps_detected' : 'checkpoint_complete' };
  });
  return { source: source.id, instance: source.instance, status: 'partial_unmeasured', observedEvents: rows.filter(event => event.type !== 'checkpoint').length, checkpoints };
}
