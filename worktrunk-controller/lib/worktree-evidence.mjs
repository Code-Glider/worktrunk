import { acceptanceMatchesLaunch, checkoutProducerFence, endedManagedLaunch, inactive } from './admission.mjs';
import { digest } from './data.mjs';
import { currentGitHubOutcome } from './github-issues.mjs';

const maxIssueAgeMs = 5 * 60_000;

// This is the last successful GitHub observation. Mutation needs a fresh read
// and must compare the authority revision again under its cleanup claim.
export function worktreeTaskEvidence(config, store, project, checkout, now) {
  const producers = store.list('claim').map(row => row.value).filter(claim => claim.kind === 'producer');
  const completions = producers.filter(claim => endedManagedLaunch(claim, now) && claim.owner === config.host.id &&
    claim.task.project === project.id && claim.task.worktreeId === checkout.identity &&
    digest(claim.task.repositoryIncarnation ?? null) === digest(checkout.repositoryIncarnation) &&
    claim.roots[0].path === checkout.path && digest(claim.roots[0].incarnation) === digest(checkout.incarnation));
  if (!completions.length) return { status: 'completed_launch_unavailable' };
  const current = completions.filter(claim => claim.priorProducerFence === checkoutProducerFence(producers, checkout, claim.token));
  if (current.length !== 1) return { status: 'checkout_producer_history_changed' };
  const launch = current[0], task = launch.task;
  const evidence = { claimToken: launch.token, sourceInstance: task.sourceInstance, issue: task.issue, attempt: task.attempt, endedAt: launch.endedAt, endedHead: launch.endedHead };
  if (producers.some(claim => claim.task?.taskKey === task.taskKey && claim.task.attempt > task.attempt)) return { ...evidence, status: 'newer_issue_attempt' };
  if (launch.endedHead !== checkout.head) return { ...evidence, status: 'checkout_head_changed' };
  const source = config.eventSources.find(source => source.github && source.instance === task.sourceInstance &&
    source.projects[0] === project.id && String(source.github.repositoryId) === task.authorityProject);
  if (!source || digest(store.get('event_source', source.instance)?.value.source ?? null) !== digest(source)) return { ...evidence, status: 'issue_source_unavailable' };
  const snapshot = store.get('github_issue', digest([source.instance, task.issue]));
  if (snapshot?.value.taskKey !== task.taskKey || snapshot.value.sourceInstance !== source.instance) return { ...evidence, status: 'issue_observation_unavailable' };
  const { observedAt, readStartedAt } = snapshot.value;
  const observed = { ...evidence, observedAt, issueRevision: snapshot.revision };
  if (!Number.isSafeInteger(readStartedAt) || !Number.isSafeInteger(observedAt) ||
    readStartedAt < launch.endedAt || observedAt < readStartedAt || observedAt > now || now - readStartedAt > maxIssueAgeMs) return { ...observed, status: 'issue_observation_stale' };
  const events = store.list('event').map(row => row.value.event).filter(event =>
    event.authority === source.authority && event.authorityProject === task.authorityProject && event.taskId === task.taskId);
  if (events.some(event => event.project !== project.id)) return { ...observed, status: 'issue_outcome_unavailable' };
  const { status, latest } = currentGitHubOutcome(events, snapshot.value, now);
  if (status === 'reopened') return { ...observed, status: 'issue_reopened' };
  if (status !== 'accepted') return { ...observed, status: 'issue_outcome_unavailable' };
  if (!acceptanceMatchesLaunch(latest, launch)) return { ...observed, status: 'issue_acceptance_mismatch' };
  return { ...observed, status: 'accepted', acceptanceId: latest.eventId, acceptedAt: latest.at };
}

export function worktreeProducerEvidence(store, project, checkout, nativeHost, claimToken) {
  if (!inactive(store, checkout.path)) return { status: 'active_or_unresolved_claim' };
  if (project.producerAdmission !== 'cooperative-windows-job-v1') return { status: 'contract_unavailable' };
  if (!nativeHost) return { status: 'native_host_unavailable' };
  const launch = claimToken && store.get('claim', claimToken)?.value;
  if (launch?.task?.producerAdmission !== project.producerAdmission ||
    digest(launch.task.nativeHost ?? null) !== digest(nativeHost)) return { status: 'launch_contract_unavailable' };
  return { status: 'inactive', contract: project.producerAdmission, nativeHost };
}
