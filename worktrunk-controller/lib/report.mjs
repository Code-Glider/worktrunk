import { digest, integer } from './data.mjs';
import { sourceCoverage } from './events.mjs';
import { acceptanceMatchesLaunch, endedManagedLaunch } from './admission.mjs';
import { currentGitHubOutcome } from './github-issues.mjs';
import { worktreeApplyEnabled } from './config.mjs';

const terminalTypes = new Map([['attempt_accepted', 'accepted'], ['attempt_failed', 'failed'], ['attempt_cancelled', 'cancelled']]);
const order = (a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || (a.sequence ?? Infinity) - (b.sequence ?? Infinity) || a.eventId.localeCompare(b.eventId);
const inWindow = (at, from, to) => at !== null && at >= from && at < to;
const firstTime = events => events.length && events.every(event => event.at !== null) ? Math.min(...events.map(event => event.at)) : null;
const quantile = (values, p) => values.length ? values[Math.ceil(values.length * p) - 1] : null;

function weekStart(at) {
  const date = new Date(at);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}

function taskProjection(key, events, now, githubIssue, launches) {
  const task = events[0] ?? { ...launches[0].task, authority: 'github.com/issues' };
  const isGitHub = task.authority === 'github.com/issues';
  const attempts = new Map();
  for (const event of events) if (event.attemptId) {
    const rows = attempts.get(event.attemptId) ?? [];
    rows.push(event); attempts.set(event.attemptId, rows);
  }
  const launchByAttempt = new Map(launches.map(launch => [String(launch.task.attempt), launch]));
  for (const id of launchByAttempt.keys()) if (!attempts.has(id)) attempts.set(id, []);
  const projected = [...attempts.entries()].map(([id, rows]) => {
    const launch = launchByAttempt.get(id);
    const numbers = new Set(rows.map(row => row.attemptNumber));
    if (launch) numbers.add(launch.task.attempt);
    const terminals = rows.filter(row => terminalTypes.has(row.type));
    const outcomes = new Set(terminals.map(row => terminalTypes.get(row.type)));
    const conflictingHeads = isGitHub && new Set(terminals.map(row => row.head)).size > 1;
    return {
      id, number: numbers.size === 1 ? [...numbers][0] : null,
      startedAt: launch?.admittedAt ?? firstTime(rows.filter(row => row.type === 'attempt_started')),
      terminal: outcomes.size > 1 || conflictingHeads ? 'ambiguous' : ([...outcomes][0] ?? null), terminalAt: firstTime(terminals),
      ...(launch?.completionVerified ? { managed: { worktreeId: launch.task.worktreeId, endedAt: launch.endedAt, head: launch.endedHead } } : {}),
    };
  }).sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity) || a.id.localeCompare(b.id));
  const accepted = events.filter(event => event.type === 'attempt_accepted');
  const firstAcceptedAt = firstTime(accepted);
  const acceptedRows = accepted.filter(event => event.at === firstAcceptedAt);
  const agents = new Set(acceptedRows.map(row => JSON.stringify(row.agentIds)));
  const acceptedLaunch = launchByAttempt.get(acceptedRows[0]?.attemptId);
  const matchedLaunch = acceptedLaunch?.completionVerified && acceptedRows.every(row => acceptanceMatchesLaunch(row, acceptedLaunch));
  const firstLaunch = launchByAttempt.get('1');
  const projectConflict = new Set([...events.map(event => event.project), ...launches.map(launch => launch.task.project)]).size !== 1;
  const agentIds = isGitHub
    ? matchedLaunch && !projectConflict && acceptedLaunch.task.agentId ? [acceptedLaunch.task.agentId] : []
    : agents.size === 1 && acceptedRows.every(row => row.attemptId) ? acceptedRows[0].agentIds : [];
  const startedAt = isGitHub ? firstLaunch?.admittedAt ?? null : firstTime(events.filter(event => event.type === 'task_started'));
  const githubOutcome = isGitHub ? currentGitHubOutcome(events, githubIssue, now) : null;
  const stateRows = isGitHub ? [] : events.filter(event => ['task_reopened', 'task_revoked', 'attempt_accepted'].includes(event.type)).sort(order);
  const latest = githubOutcome?.latest ?? stateRows.at(-1);
  const ambiguousClock = events.some(event => event.at === null || event.at > now);
  const hasCurrentConflict = !isGitHub && projected.some(attempt => attempt.terminal === 'ambiguous');
  const invalidOrdering = projected.some(attempt => attempt.startedAt !== null && attempt.terminalAt !== null && attempt.terminalAt < attempt.startedAt) || (startedAt !== null && firstAcceptedAt !== null && firstAcceptedAt < startedAt);
  const ordinalKnown = projected.length > 0 && projected.every(attempt => attempt.number !== null) && new Set(projected.map(attempt => attempt.number)).size === projected.length;
  const firstAttempt = ordinalKnown ? projected.find(attempt => attempt.number === 1) ?? null : null;
  const sameTimeConflict = latest && stateRows.some(event => event.at === latest.at && event.type !== latest.type);
  const currentOutcome = ambiguousClock || projectConflict || hasCurrentConflict || sameTimeConflict || !latest ? 'unknown'
    : githubOutcome?.status ?? (latest.type === 'attempt_accepted' ? 'accepted' : latest.type === 'task_reopened' ? 'reopened' : 'revoked');
  const openedAt = currentOutcome === 'reopened' ? latest.at : !latest && !accepted.length ? startedAt : null;
  return {
    id: key, authority: task.authority, authorityProject: task.authorityProject, taskId: task.taskId, project: task.project,
    ...(isGitHub ? { authorityObservedAt: githubIssue?.observedAt ?? null } : {}),
    startedAt, firstAcceptedAt, currentOutcome,
    agentIds, attribution: agentIds.length === 1 ? 'single_agent' : agentIds.length > 1 ? 'multiple_agents' : 'unavailable',
    durationMs: !ambiguousClock && !projectConflict && !invalidOrdering && startedAt !== null && firstAcceptedAt !== null &&
      (!isGitHub || (matchedLaunch && firstLaunch?.completionVerified && firstLaunch.task.sourceInstance === acceptedLaunch.task.sourceInstance && startedAt <= acceptedLaunch.admittedAt))
      ? firstAcceptedAt - startedAt : null,
    attempts: projected, observedAttempts: projected.length, observedRetries: projected.length ? projected.length - 1 : null,
    firstAttempt: projectConflict || ambiguousClock || invalidOrdering || !firstAttempt || firstAttempt.terminal === 'ambiguous' ? null : firstAttempt,
    openAgeMs: openedAt !== null && openedAt <= now && !ambiguousClock && !projectConflict && !hasCurrentConflict && !invalidOrdering ? now - openedAt : null,
    timingStatus: ambiguousClock || projectConflict ? 'unavailable' : 'observed_partial',
  };
}

function sessionProjection(key, events, sourceSequences, from, to) {
  const ordered = [...events].sort(order);
  const attributes = ordered.at(-1);
  const rows = events.filter(event => event.type !== 'association').sort(order);
  const intervals = [];
  let ambiguous = !rows.length || rows.some(row => row.at === null);
  const sequenced = rows.filter(row => row.sequence !== null).sort((a, b) => a.sequence - b.sequence);
  if (sequenced.some((row, i) => i && row.at < sequenced[i - 1].at)) ambiguous = true;
  const issues = [];
  if (rows.some((row, i) => rows.slice(i + 1).some(other => row.at === other.at && row.type !== other.type && (row.sequence === null || other.sequence === null)))) {
    ambiguous = true; issues.push('simultaneous_state_conflict');
  }
  for (let i = 0; i + 1 < rows.length; i++) {
    const row = rows[i], next = rows[i + 1];
    if (!['working', 'waiting'].includes(row.type) || row.at === null || next.at === null || next.at < row.at) continue;
    if (row.sequence !== null && next.sequence !== null && sourceSequences.filter(sequence => sequence > row.sequence && sequence < next.sequence).length !== next.sequence - row.sequence - 1) {
      ambiguous = true; issues.push('source_sequence_gap');
    }
    const start = Math.max(from, row.at), end = Math.min(to, next.at);
    if (end > start) intervals.push({ start, end, state: row.type });
  }
  const latest = rows.at(-1) ?? attributes;
  if (rows.some((row, i) => row.type === 'session_ended' && i < rows.length - 1)) ambiguous = true;
  return {
    id: key, sourceInstance: attributes.sourceInstance, sessionId: attributes.sessionId,
    currentState: !ambiguous && latest.type === 'session_ended' ? 'ended' : 'unknown', lastObservedState: latest.type,
    project: attributes.project,
    worktreeId: ordered.findLast(event => event.worktreeId !== null)?.worktreeId ?? null,
    repositoryId: ordered.findLast(event => event.repositoryId !== null)?.repositoryId ?? null,
    durationIssues: [...new Set(issues)],
    durationStatus: ambiguous || !intervals.length ? 'unavailable' : 'observed_partial',
    observedWorkingMs: ambiguous || !intervals.length ? null : intervals.filter(interval => interval.state === 'working').reduce((sum, interval) => sum + interval.end - interval.start, 0),
    observedWaitingMs: ambiguous || !intervals.length ? null : intervals.filter(interval => interval.state === 'waiting').reduce((sum, interval) => sum + interval.end - interval.start, 0),
    intervals: ambiguous ? [] : intervals,
  };
}

// Reports rebuild from immutable normalized events. Counts are observed cohorts,
// not an estimate of unrecorded tasks, agent usage, or process liveness.
export function report(config, store, { from, to, now = Date.now() }) {
  integer(from, 'report from'); integer(to, 'report to', from + 1); integer(now, 'report now');
  if (to > now || !Number.isFinite(new Date(to).getTime())) throw new Error('Report window must end by now');
  const registered = new Set(config.projects.map(project => project.id));
  const allEvents = store.list('event').map(row => row.value.event);
  const events = allEvents.filter(event => registered.has(event.project));
  const taskGroups = new Map(), sessionGroups = new Map();
  let unassociatedTaskEvents = 0, unassociatedSessionEvents = 0;
  for (const event of events) {
    if (event.type === 'checkpoint') continue;
    if (event.sourceRole === 'task') {
      if (!event.taskId || !event.authorityProject) { unassociatedTaskEvents++; continue; }
      const key = digest([event.authority, event.authorityProject, event.taskId]);
      const rows = taskGroups.get(key) ?? []; rows.push(event); taskGroups.set(key, rows);
    } else {
      if (!event.sessionId) { unassociatedSessionEvents++; continue; }
      const key = digest([event.sourceInstance, event.sessionId]);
      const rows = sessionGroups.get(key) ?? []; rows.push(event); sessionGroups.set(key, rows);
    }
  }
  const githubSources = new Map(config.eventSources.filter(source => source.github).map(source => [source.instance, source]));
  const githubIssues = new Map(store.list('github_issue').filter(row => {
    const source = githubSources.get(row.value.sourceInstance);
    return source && digest(store.get('event_source', source.instance)?.value.source ?? null) === digest(source) && row.value.observedAt <= now;
  }).map(row => [row.value.taskKey, row.value]));
  const githubIssueReads = [];
  for (const { sourceInstance, issue, observedAt } of githubIssues.values()) {
    const source = githubSources.get(sourceInstance);
    const project = source.projects[0];
    if (registered.has(project) && Number.isSafeInteger(issue) && issue > 0 && Number.isSafeInteger(observedAt) && observedAt >= 0) {
      githubIssueReads.push({ source: source.id, project, issue, observedAt });
    }
  }
  githubIssueReads.sort((a, b) => a.source.localeCompare(b.source) || a.issue - b.issue);
  const launches = new Map();
  for (const { value } of store.list('claim')) {
    const task = value.task;
    if (!task || !registered.has(task.project)) continue;
    const completionVerified = endedManagedLaunch(value, now);
    const admissionRecorded = value.kind === 'producer' && ['running', 'unresolved'].includes(value.state) &&
      value.evidence?.kind === 'windows_job' && value.evidence.launchToken === value.token && value.evidence.activeProcesses === null &&
      Number.isSafeInteger(value.admittedAt) && value.admittedAt >= 0 && value.admittedAt <= now;
    if (!completionVerified && !admissionRecorded) continue;
    const rows = launches.get(task.taskKey) ?? [];
    rows.push({ ...value, completionVerified }); launches.set(task.taskKey, rows);
    if (!taskGroups.has(task.taskKey)) taskGroups.set(task.taskKey, []);
  }
  const tasks = [...taskGroups].map(([key, rows]) => taskProjection(key, rows, now, githubIssues.get(key), launches.get(key) ?? [])).sort((a, b) => a.id.localeCompare(b.id));
  const sessions = [...sessionGroups].map(([key, rows]) => sessionProjection(key, rows, allEvents.filter(event => event.sourceInstance === rows[0].sourceInstance && event.sequence !== null).map(event => event.sequence), from, to)).sort((a, b) => a.id.localeCompare(b.id));
  const cohorts = new Map();
  const acceptedTasks = tasks.filter(task => inWindow(task.firstAcceptedAt, from, to) && task.timingStatus !== 'unavailable');
  const attribution = { singleAgent: {}, multipleAgents: 0, unavailable: 0 };
  for (const task of acceptedTasks) {
    const week = weekStart(task.firstAcceptedAt);
    cohorts.set(week, (cohorts.get(week) ?? 0) + 1);
    if (task.attribution === 'single_agent') {
      const agent = task.agentIds[0];
      Object.defineProperty(attribution.singleAgent, agent, { value: (Object.hasOwn(attribution.singleAgent, agent) ? attribution.singleAgent[agent] : 0) + 1, enumerable: true, configurable: true, writable: true });
    } else if (task.attribution === 'multiple_agents') attribution.multipleAgents++;
    else attribution.unavailable++;
  }
  const outcomes = { accepted: 0, failed: 0, cancelled: 0, total: 0, acceptanceRate: null, unavailableTasks: tasks.filter(task => !task.firstAttempt).length };
  for (const task of tasks) if (task.firstAttempt?.terminal && inWindow(task.firstAttempt.terminalAt, from, to)) { outcomes[task.firstAttempt.terminal]++; outcomes.total++; }
  if (outcomes.total) outcomes.acceptanceRate = outcomes.accepted / outcomes.total;
  const durations = acceptedTasks.map(task => task.durationMs).filter(value => value !== null).sort((a, b) => a - b);
  const byHost = new Map();
  for (const session of sessions) {
    const points = byHost.get(session.sourceInstance) ?? [];
    for (const interval of session.intervals) points.push([interval.start, 1], [interval.end, -1]);
    byHost.set(session.sourceInstance, points);
  }
  const concurrency = [...byHost].map(([instance, points]) => {
    points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let active = 0, maximum = 0, previous = from, overlapMs = 0;
    for (const [at, change] of points) { if (active > 1) overlapMs += at - previous; active += change; maximum = Math.max(maximum, active); previous = at; }
    return { instance, observedOverlapMs: points.length ? overlapMs : null, maxObservedConcurrentSessions: points.length ? maximum : null };
  });
  const sourceMap = new Map(store.list('event_source').map(row => [row.value.source.instance, row.value.source]));
  for (const source of config.eventSources) sourceMap.set(source.instance, source);
  const scans = store.list('scan').filter(row => registered.has(row.id)).map(row => row.value);
  const artifactScans = new Map(store.list('artifact_scan').map(row => [row.id, row.value]));
  const artifacts = (config.artifactRoots ?? []).filter(root => root.projects.some(id => registered.has(id))).map(root => {
    const latest = artifactScans.get(root.id), previous = latest?.previous;
    const current = latest?.policyGeneration === config.generation;
    const a = previous?.decision.evidence, b = latest?.decision.evidence;
    const growthKnown = current && previous?.policyGeneration === config.generation && a?.identity && a.identity === b?.identity && digest(a.incarnation) === digest(b.incarnation) && Number.isSafeInteger(a.enrolledAt) && a.enrolledAt > 0 && a.enrolledAt === b.enrolledAt && a.enrolledAt <= previous.observedAt && inWindow(previous.observedAt, from, to) && inWindow(latest.observedAt, from, to) && previous.observedAt < latest.observedAt;
    return { artifactId: root.id, observedAt: latest?.observedAt ?? null, policyCurrent: Boolean(current), status: latest?.decision.status ?? 'unavailable', reasons: latest?.decision.reasons ?? ['artifact_observation_unavailable'], logicalBytes: current ? b?.contents.logicalBytes ?? null : null, growthBytes: growthKnown ? b.contents.logicalBytes - a.contents.logicalBytes : null, growthFrom: growthKnown ? previous.observedAt : null, growthTo: growthKnown ? latest.observedAt : null };
  });
  const actions = store.list('action').map(row => row.value).filter(action => action.owner === config.host?.id &&
    (action.kind === 'worktree' ? registered.has(action.project) : action.projects?.some(id => registered.has(id))));
  const artifactPurges = { observedActions: 0, logicalBytes: 0, unavailableTimeActions: 0 };
  for (const action of actions) {
    if (action.kind !== 'artifact' || action.phase !== 'purged' || action.purgeOutcome !== 'complete') continue;
    if (![action.createdAt, action.quarantinedAt, action.purgedAt].every(Number.isSafeInteger) || action.createdAt < 0 || action.quarantinedAt < action.createdAt || action.purgedAt < action.quarantinedAt || action.purgedAt > now) {
      artifactPurges.unavailableTimeActions++;
      continue;
    }
    if (!inWindow(action.purgedAt, from, to)) continue;
    artifactPurges.observedActions++;
    const bytes = action.version === 1 ? action.baseline?.contents?.logicalBytes : null;
    const total = Number.isSafeInteger(bytes) && bytes >= 0 && artifactPurges.logicalBytes !== null ? artifactPurges.logicalBytes + bytes : null;
    artifactPurges.logicalBytes = Number.isSafeInteger(total) ? total : null;
  }
  return {
    version: 1, from, to, asOf: now, applyEnabled: Boolean(config.policy?.allowApply && process.platform === 'win32' && config.nativeHost), worktreeApplyEnabled: worktreeApplyEnabled(config),
    actions: actions.map(action => ({ id: action.id, ...(action.kind === 'worktree' ? { kind: action.kind, project: action.project } : { artifactId: action.artifactId }),
      phase: action.phase, originalPath: action.originalPath, payloadPath: action.payloadPath, createdAt: action.createdAt, quarantinedAt: action.quarantinedAt, purgedAt: action.purgedAt ?? null, purgeOutcome: action.purgeOutcome ?? null, error: action.error })),
    artifactPurges,
    coverage: [...sourceMap.values()].map(source => sourceCoverage(source, allEvents)), githubIssueReads,
    unassociatedTaskEvents, unassociatedSessionEvents,
    observedFirstAcceptedTasks: acceptedTasks.length,
    weeks: [...cohorts].sort(([a], [b]) => a.localeCompare(b)).map(([week, observedFirstAcceptedTasks]) => ({ week, observedFirstAcceptedTasks })),
    firstAttemptOutcomes: outcomes, attribution,
    acceptedTaskDuration: { samples: durations.length, unavailable: acceptedTasks.length - durations.length, medianMs: durations.length ? (durations[Math.floor((durations.length - 1) / 2)] + durations[Math.floor(durations.length / 2)]) / 2 : null, p95Ms: quantile(durations, 0.95) },
    observedReopens: events.filter(event => event.type === 'task_reopened' && inWindow(event.at, from, to)).length,
    observedRevocations: events.filter(event => event.type === 'task_revoked' && inWindow(event.at, from, to)).length,
    backlog: scans.map(scan => {
      const failed = scan.status === 'analysis_failed';
      const decisions = failed ? null : scan.decisions;
      const policyCurrent = scan.policyGeneration === config.generation;
      const eligibleCandidates = !failed && policyCurrent && scan.eligibleCandidates ? [...scan.eligibleCandidates].sort((a, b) =>
        (b.estimatedReclaimableBytes ?? -1) - (a.estimatedReclaimableBytes ?? -1) ||
        (a.estimatedReclaimableBytes === null ? b.logicalBytes - a.logicalBytes : 0) ||
        a.rebuildFiles - b.rebuildFiles || a.path.localeCompare(b.path)) : null;
      return {
        project: scan.project, observedAt: scan.observedAt ?? null, policyCurrent,
        status: failed ? 'analysis_failed' : 'observed', ...(failed ? { error: scan.error } : {}),
        worktrees: decisions?.length ?? null,
        eligible: decisions?.filter(item => item.status === 'eligible').length ?? null,
        eligibleCandidates,
        retained: decisions?.filter(item => item.status === 'retain').length ?? null,
        analysisFailed: decisions?.filter(item => item.status === 'analysis_failed').length ?? null,
        staleRegistrations: decisions?.filter(item => item.reasons.includes('stale_registration_report_only')).length ?? null,
        reasons: decisions?.flatMap(item => item.reasons) ?? [],
      };
    }),
    artifacts, artifactGrowthBytes: artifacts.length && artifacts.every(root => root.growthBytes !== null) ? artifacts.reduce((total, root) => total + root.growthBytes, 0) : null, reclaimedBytes: null, usage: null,
    tasks, sessions, concurrency,
  };
}
