#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig, worktreeApplyEnabled } from '../lib/config.mjs';
import { Store } from '../lib/store.mjs';
import { invocation } from '../lib/invoke.mjs';
import { enroll } from '../lib/identity.mjs';
import { scanProject } from '../lib/observe.mjs';
import { localPath } from '../lib/paths.mjs';
import { ingest, syncGitHubIssue, syncKnownGitHubIssues } from '../lib/events.mjs';
import { report } from '../lib/report.mjs';
import { managedCheckout, runManaged } from '../lib/managed.mjs';
import { enrollArtifact, inspectArtifact } from '../lib/artifacts.mjs';
import { quarantineArtifact, restore, reconcile, inspectQuarantine, purgeArtifact,
  moveWorktreeToQuarantine, lockWorktreeQuarantine, restoreWorktree, inspectWorktreeQuarantine, purgeWorktree } from '../lib/actions.mjs';

function readEvent() {
  const chunks = [], buffer = Buffer.alloc(4096);
  let total = 0, size;
  while ((size = fs.readSync(0, buffer, 0, buffer.length, null))) {
    if ((total += size) > 65536) throw new Error('Event input exceeds 64 KiB');
    chunks.push(Buffer.from(buffer.subarray(0, size)));
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

function utcDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) throw new Error('Report dates must use YYYY-MM-DD in UTC');
  const at = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== value) throw new Error('Invalid UTC report date');
  return at;
}

const positiveNumber = value => /^[1-9]\d*$/.test(value ?? '') && Number.isSafeInteger(Number(value));

try {
  const { values, positionals } = parseArgs({ options: { config: { type: 'string' }, project: { type: 'string' }, artifact: { type: 'string' }, decision: { type: 'string' }, action: { type: 'string' }, path: { type: 'string' }, source: { type: 'string' }, issue: { type: 'string' }, attempt: { type: 'string' }, agent: { type: 'string' }, session: { type: 'string' }, program: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, format: { type: 'string', default: 'text' } }, allowPositionals: true });
  const [command, ...extra] = positionals;
  const allowed = { scan: ['project', 'action'], enroll: ['project', 'path'], 'enroll-artifact': ['artifact'], ingest: ['source'], 'sync-github-issue': ['source', 'issue'], 'sync-github-issues': [], report: ['project', 'from', 'to'], run: ['project', 'path', 'session', 'program', 'source', 'issue', 'attempt', 'agent'], apply: ['decision'], purge: ['decision'], restore: ['action'], reconcile: ['action'] };
  if ((extra.length && command !== 'run') || !Object.hasOwn(allowed, command) || !values.config || !['json', 'text'].includes(values.format)) throw new Error('Usage: node worktrunk-controller/bin/controller.mjs scan|enroll|enroll-artifact|ingest|sync-github-issue|sync-github-issues|report|run|apply|purge|restore|reconcile --config <absolute-file> [--project <id>] [--artifact <id>] [--decision <id>] [--action <id>] [--path <absolute-worktree>] [--source <id>] [--issue <number>] [--attempt <number>] [--agent <id>] [--from YYYY-MM-DD --to YYYY-MM-DD] [--format json|text] [--session <id> --program <absolute-executable> -- <args>...]');
  if (Object.keys(values).some(key => !['config', 'format', ...allowed[command]].includes(key))) throw new Error('Option is not supported for this command');
  if (['enroll', 'run'].includes(command) !== Boolean(values.path) || (['enroll', 'run'].includes(command) && !values.project)) throw new Error('Enrollment/managed run require --project and --path');
  if (command === 'run' && (!values.session || !values.program)) throw new Error('Managed run requires --session and --program');
  const bindTask = command === 'run' && ['source', 'issue', 'attempt', 'agent'].some(option => Object.hasOwn(values, option));
  if (bindTask && (!values.source || !positiveNumber(values.issue) || !positiveNumber(values.attempt))) throw new Error('Managed task requires --source, --issue and --attempt');
  if (command === 'ingest' && !values.source) throw new Error('Ingestion requires a configured --source and one JSON event on stdin');
  if (command === 'sync-github-issue' && (!values.source || !positiveNumber(values.issue))) throw new Error('GitHub issue sync requires --source and a positive --issue number');
  if (command === 'enroll-artifact' && !values.artifact) throw new Error('Artifact enrollment requires a configured --artifact');
  if (['apply', 'purge'].includes(command) && !values.decision) throw new Error('Apply/purge require one explicit --decision');
  if (command === 'scan' && values.action && values.project) throw new Error('Scan selects either --action or --project');
  if (['restore', 'reconcile'].includes(command) && !values.action) throw new Error('Restore/reconcile require one explicit --action');
  const window = command === 'report' ? { from: utcDate(values.from), to: utcDate(values.to) } : null;
  if (window && (window.from >= window.to || window.to > Date.now())) throw new Error('Report window must have positive duration and end by now');
  const config = loadConfig(localPath(values.config));
  const projects = config.projects.filter(project => !values.project || values.project === project.id);
  if (!projects.length) throw new Error('No matching registered project');
  const store = new Store(config.stateDir, { readOnly: command === 'report' });
  try {
    let output;
    const decisionKind = values.decision && store.get('decision', values.decision)?.value.kind;
    const actionKind = values.action && store.get('action', values.action)?.value.kind;
    if (command === 'ingest') output = ingest(config, store, values.source, readEvent());
    else if (command === 'sync-github-issue') output = await syncGitHubIssue(config, store, values.source, Number(values.issue));
    else if (command === 'sync-github-issues') {
      output = await syncKnownGitHubIssues(config, store);
      if (output.failed.length) process.exitCode = 1;
    }
    else if (command === 'apply' && decisionKind === 'worktree') {
      const moved = await moveWorktreeToQuarantine(config, store, values.decision);
      output = await lockWorktreeQuarantine(config, store, moved.id);
    } else if (command === 'apply') output = quarantineArtifact(config, store, values.decision);
    else if (command === 'purge' && decisionKind === 'worktree_purge') output = await purgeWorktree(config, store, values.decision);
    else if (command === 'purge') output = purgeArtifact(config, store, values.decision);
    else if (command === 'restore' && actionKind === 'worktree') output = await restoreWorktree(config, store, values.action);
    else if (command === 'restore') output = restore(config, store, values.action);
    else if (command === 'reconcile') output = reconcile(config, store, values.action);
    else if (command === 'report') output = report({ ...config, projects }, store, window);
    else if (command === 'enroll-artifact') output = enrollArtifact(config, store, values.artifact);
    else if (command === 'run') {
      const project = projects[0];
      const github = bindTask ? { source: values.source, issue: Number(values.issue), attempt: Number(values.attempt), agentId: values.agent } : undefined;
      const root = bindTask ? values.path : managedCheckout(config, store, project, values.path).root;
      output = await runManaged(config, store, { root, projectId: project.id, sessionId: values.session, program: values.program, args: extra, github });
      if (output.exitCode !== 0) process.exitCode = output.exitCode ?? 1;
    } else if (command === 'enroll') {
      const project = projects[0];
      output = invocation(config, project.root, ({ git }) => {
        const root = localPath(values.path);
        const common = localPath(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], root).trim());
        const expected = localPath(git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
        if (common !== expected) throw new Error('Worktree is outside the selected repository');
        const top = localPath(git(['rev-parse', '--show-toplevel'], root).trim());
        if (top !== root) throw new Error('Enrollment requires the exact worktree root');
        return enroll(store, root, git(['rev-parse', '--absolute-git-dir'], root).trim());
      });
    } else if (command === 'scan' && values.action) {
      const worktree = actionKind === 'worktree';
      const decision = worktree ? inspectWorktreeQuarantine(config, store, values.action) : inspectQuarantine(config, store, values.action);
      output = worktree ? { version: 1, worktreeApplyEnabled: worktreeApplyEnabled(config, projects.filter(project => project.id === decision.project)),
        projects: [{ project: decision.project, decisions: [decision] }], artifacts: [] } : { version: 1, projects: [], artifacts: [decision] };
      if (decision.status === 'analysis_failed') process.exitCode = 1;
      store.transaction(tx => tx.put('decision', decision.id, { version: 1, ...decision, policyGeneration: config.generation }));
    } else {
      output = { version: 1, applyEnabled: config.policy.allowApply && process.platform === 'win32' && Boolean(config.nativeHost), worktreeApplyEnabled: worktreeApplyEnabled(config, projects), projects: projects.map(project => {
        try { return scanProject(config, store, project); }
        catch (error) { process.exitCode = 1; return { version: 1, project: project.id, status: 'analysis_failed', error: error.message, decisions: [] }; }
      }) };
      output.artifactObservedAt = Date.now();
      output.artifacts = config.artifactRoots.filter(root => root.projects.some(id => projects.some(project => project.id === id))).map(root => inspectArtifact(config, store, root.id, output.artifactObservedAt));
      if (output.projects.some(project => project.decisions.some(decision => decision.status === 'analysis_failed'))) process.exitCode = 1;
      if (output.artifacts.some(decision => decision.status === 'analysis_failed')) process.exitCode = 1;
      store.transaction(tx => {
        for (const project of output.projects) {
          tx.put('scan', project.project, project);
          for (const decision of project.decisions) tx.put('decision', decision.id, { version: 1, ...decision, policyGeneration: config.generation });
        }
        for (const decision of output.artifacts) {
          const old = tx.get('artifact_scan', decision.artifactId)?.value;
          const previous = old ? { observedAt: old.observedAt, policyGeneration: old.policyGeneration, decision: old.decision } : null;
          tx.put('artifact_scan', decision.artifactId, { version: 1, observedAt: output.artifactObservedAt, policyGeneration: config.generation, decision, previous });
          tx.put('decision', decision.id, { version: 1, ...decision, policyGeneration: config.generation });
        }
      });
    }
    if (values.format === 'json') process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    else if (command === 'enroll' || command === 'enroll-artifact') process.stdout.write(`Enrolled ${output.path} (${output.id})\n`);
    else if (command === 'ingest') process.stdout.write(`${output.replay ? 'Already recorded' : 'Recorded'} event ${output.id}\n`);
    else if (command === 'sync-github-issue') process.stdout.write(`GitHub issue #${output.issue} from ${output.source}. Recorded ${output.recorded} events and replayed ${output.replayed}.\n`);
    else if (command === 'sync-github-issues') {
      process.stdout.write(`Refreshed ${output.synced.length} tracked GitHub issues. ${output.failed.length} failed.\n`);
      for (const failure of output.failed) process.stderr.write(`GitHub issue #${failure.issue} from ${failure.source}. ${failure.error}\n`);
    }
    else if (command === 'run') process.stdout.write(`Managed launch ${output.token} ended; exit ${output.exitCode ?? 'unavailable'}\n`);
    else if (['apply', 'purge', 'restore', 'reconcile'].includes(command)) process.stdout.write(`Action ${output.id}: ${output.phase}${output.purgeOutcome === 'interrupted' ? '; purge interrupted, only remaining contents can be restored' : ''}\n`);
    else if (command === 'report') {
      process.stdout.write(`Observed first accepted tasks: ${output.observedFirstAcceptedTasks}\nFirst-attempt acceptance: ${output.firstAttemptOutcomes.accepted}/${output.firstAttemptOutcomes.total}; cancellations: ${output.firstAttemptOutcomes.cancelled}\n`);
      for (const week of output.weeks) process.stdout.write(`  Week ${week.week}: ${week.observedFirstAcceptedTasks}\n`);
      process.stdout.write(`Accepted task duration: median ${output.acceptedTaskDuration.medianMs ?? 'unavailable'} ms; p95 ${output.acceptedTaskDuration.p95Ms ?? 'unavailable'} ms; samples ${output.acceptedTaskDuration.samples}\n`);
      for (const artifact of output.artifacts) process.stdout.write(`  Artifact ${artifact.artifactId}: ${artifact.logicalBytes ?? 'unavailable'} logical bytes; observed growth ${artifact.growthBytes ?? 'unavailable'} bytes\n`);
      process.stdout.write(`Artifact purges: ${output.artifactPurges.observedActions} actions; ${output.artifactPurges.logicalBytes ?? 'unavailable'} logical bytes; ${output.artifactPurges.unavailableTimeActions} actions with unavailable time\n`);
      for (const action of output.actions) process.stdout.write(`  ${action.kind === 'worktree' ? `Worktree action ${action.id} (${action.project})` : `Action ${action.id}`}: ${action.phase}${action.purgeOutcome === 'interrupted' ? '; interrupted purge, remaining contents only' : ''}${action.error ? ` (${action.error})` : ''}\n`);
      for (const source of output.coverage) process.stdout.write(`  ${source.source}: ${source.status}; observed events ${source.observedEvents}\n`);
    }
    else {
      for (const project of output.projects) {
        const enabled = worktreeApplyEnabled(config, projects.filter(registered => registered.id === project.project));
        process.stdout.write(`${project.project ?? 'Worktree action'}: ${project.status ?? `${project.decisions.length} worktrees`}; worktree apply ${enabled ? 'enabled' : 'disabled'}\n`);
        if (project.error) process.stdout.write(`  ${project.error}\n`);
        for (const decision of project.decisions) {
          const target = decision.path ? path.normalize(decision.path) : decision.actionId;
          const selection = decision.status === 'eligible' ? ` [decision ${decision.id}]` : '';
          process.stdout.write(`  ${decision.status} ${target}${selection}: ${decision.reasons.join(', ')}${decision.error ? ` (${decision.error})` : ''}\n`);
        }
      }
      for (const decision of output.artifacts) process.stdout.write(`  ${decision.status} artifact ${decision.artifactId}: ${decision.reasons.join(', ')}${decision.error ? ` (${decision.error})` : ''}\n`);
    }
  } finally { store.close(); }
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
