export function decideWorktree(facts, policy, now) {
  const reasons = [];
  if (['main', 'defaultBranch', 'protectedPath', 'locked', 'stale', 'dirty', 'hiddenIndex', 'untracked', 'ignored', 'nested', 'links', 'operation', 'acceptedTask', 'inactiveProducers'].some(key => typeof facts[key] !== 'boolean')) reasons.push('facts_incomplete');
  if (facts.main) reasons.push('primary_checkout');
  if (facts.defaultBranch) reasons.push('default_branch');
  if (facts.protectedPath) reasons.push('protected_path');
  if (facts.locked) reasons.push('user_lock');
  if (facts.stale) reasons.push('stale_registration_report_only');
  if (!facts.identity) reasons.push('unmanaged_incarnation');
  if (!facts.enrolledAt || now < facts.enrolledAt) reasons.push('age_unknown');
  else if (now - facts.enrolledAt < policy.minAgeMs) reasons.push('too_young');
  if (!facts.integration) reasons.push('not_integrated');
  if (facts.dirty) reasons.push('uncommitted_changes');
  if (facts.hiddenIndex) reasons.push('hidden_index_entries');
  if (facts.untracked) reasons.push('untracked_content');
  if (facts.ignored) reasons.push('ignored_content_unclassified');
  if (facts.nested) reasons.push('nested_repository');
  if (facts.links) reasons.push('link_content');
  if (facts.operation) reasons.push('operation_in_progress');
  if (!facts.acceptedTask) reasons.push('task_outcome_unavailable');
  if (!facts.inactiveProducers) reasons.push('producer_admission_unavailable');
  return { status: reasons.length ? 'retain' : 'eligible', reasons };
}
