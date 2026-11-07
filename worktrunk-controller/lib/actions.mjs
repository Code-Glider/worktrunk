// Artifact moves serialize with SQLite. Worktree commands start only after their
// journal commit and retain ownership until the native receipt and Git agree.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, integer, text } from './data.mjs';
import { fileIdentity, localPath, overlap } from './paths.mjs';
import { acquireCleanup, holdsWorktreeRepository, verifyCleanupFences } from './admission.mjs';
import { inspectArtifact } from './artifacts.mjs';
import { loadConfig } from './config.mjs';
import { syncGitHubIssueSnapshot } from './events.mjs';
import { managedCheckout } from './managed.mjs';
import { recordRelocation } from './identity.mjs';
import { invocation, isolatedGitArgs, openInvocation } from './invoke.mjs';
import { readCommandCompletion, runJournaledCommand } from './native-host.mjs';
import { scanProject } from './observe.mjs';
import { sampleClock, retentionStatus } from './retention.mjs';
import { maxIssueAgeMs } from './worktree-evidence.mjs';

const terminal = new Set(['restored', 'cancelled', 'purged']);
const same = (a, b) => digest(a) === digest(b);

function at(filename) {
  localPath(filename, { missing: true });
  try { return fileIdentity(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function read(config, tx, id, kind = 'artifact') {
  const action = tx.get('action', text(id, 'action ID'))?.value;
  if (!action || action.kind !== kind || action.id !== id || !/^[a-f0-9-]{36}$/.test(id) || action.owner !== config.host.id || action.domain !== process.platform) throw new Error(`Matching owned ${kind} action required`);
  if (!['intent', 'prepared', 'moving', 'moved', 'locking', 'quarantined', 'unlocking', 'unlocked', 'restoring', 'restored', 'cancelled', 'purging', 'purged'].includes(action.phase)) throw new Error('Unsupported action phase');
  if (action.quarantineRoot !== config.quarantineDir || action.containerPath !== path.join(config.quarantineDir, id) || action.payloadPath !== path.join(action.containerPath, 'payload')) throw new Error('Quarantine boundary does not match manifest');
  const claim = tx.get('claim', action.claimToken)?.value;
  if (!claim || claim.actionId !== id || claim.token !== action.claimToken || claim.kind !== 'cleanup' || claim.owner !== action.owner || claim.roots.length !== 1 || claim.roots[0].path !== action.originalPath || !same(claim.roots[0].incarnation, action.incarnation) || claim.state !== (terminal.has(action.phase) ? 'released' : 'held')) throw new Error('Action ownership claim unavailable');
  return { action, claim };
}

function boundaries(action) {
  localPath(action.originalPath, { missing: true });
  localPath(action.containerPath, { missing: true });
  if (!same(fileIdentity(path.dirname(action.originalPath)), action.originalParent) || !same(fileIdentity(path.dirname(action.quarantineRoot)), action.quarantineParent)) throw new Error('Action parent incarnation changed');
  if (action.quarantineIdentity && !same(at(action.quarantineRoot), action.quarantineIdentity)) throw new Error('Quarantine root incarnation changed');
  if (action.containerIdentity) {
    if (!same(at(action.containerPath), action.containerIdentity)) throw new Error('Quarantine container incarnation changed');
  } else if (at(action.containerPath)) throw new Error('Unverified quarantine container requires explicit repair');
}

function location(action) {
  boundaries(action);
  const original = at(action.originalPath), payload = at(action.payloadPath);
  if (same(original, action.incarnation) && payload === null) return 'original';
  if (original === null && same(payload, action.incarnation) && action.containerIdentity) return 'payload';
  throw new Error('Action locations are ambiguous or substituted');
}

function complete(tx, action, claim, phase) {
  const next = { ...action, phase, error: null };
  tx.put('action', action.id, next);
  tx.put('claim', claim.token, { ...claim, state: terminal.has(phase) ? 'released' : 'held', roots: [{ path: action.originalPath, incarnation: action.incarnation, ...(['moved', 'quarantined', 'unlocked', 'purging'].includes(phase) ? { currentPath: action.payloadPath } : {}) }] });
  return next;
}

function failed(config, store, id, error) {
  try {
    store.transaction(tx => {
      const action = tx.get('action', id)?.value;
      if (action?.owner === config.host.id && action.domain === process.platform && !terminal.has(action.phase)) tx.put('action', id, { ...action, error: error.message });
    });
  } catch { /* Failed error persistence must not replace the original failure. */ }
  throw new Error(`Action ${id}: ${error.message}`, { cause: error });
}

function beginQuarantine(config, store, selected, id, now, details) {
  const originalPath = localPath(selected.path), containerPath = path.join(config.quarantineDir, id);
  acquireCleanup(store, { roots: [originalPath], owner: config.host.id, actionId: id }, (tx, claim) => {
    tx.put('action', id, {
      ...details(tx, originalPath),
      version: 1, id, kind: selected.kind, owner: config.host.id, domain: process.platform,
      claimToken: claim.token, decisionId: selected.id, policyGeneration: config.generation,
      originalPath, incarnation: selected.evidence.incarnation, originalParent: fileIdentity(path.dirname(originalPath)),
      quarantineRoot: config.quarantineDir, quarantineParent: fileIdentity(path.dirname(config.quarantineDir)), quarantineIdentity: null,
      containerPath, containerIdentity: null, payloadPath: path.join(containerPath, 'payload'),
      phase: 'intent', createdAt: now, quarantinedAt: null, error: null,
    });
  });
  return store.get('action', id).value;
}

function prepareQuarantine(tx, action) {
  if (action.phase !== 'intent' || location(action) !== 'original') throw new Error('Quarantine intent is no longer pending');
  try { fs.mkdirSync(action.quarantineRoot, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const quarantineIdentity = fileIdentity(action.quarantineRoot);
  if (!fs.statSync(action.quarantineRoot).isDirectory() || quarantineIdentity.dev !== action.incarnation.dev) throw new Error('Quarantine must be a directory on the same filesystem');
  fs.mkdirSync(action.containerPath, { mode: 0o700 });
  tx.put('action', action.id, { ...action, phase: 'prepared', quarantineIdentity, containerIdentity: fileIdentity(action.containerPath) });
}

function requireCurrentWorktreeConfig(config) {
  const current = loadConfig(config.configPath);
  if (current.generation !== config.generation || current.registryPath !== config.registryPath) throw new Error('Worktree configuration changed; scan again before applying');
}

function repositoryPaths(checkout) {
  return [checkout.common, ...checkout.worktrees.map(entry => localPath(entry.path, { missing: true }))].sort();
}

export function beginWorktreeAction(config, store, decisionId) {
  if (!config.policy.allowApply || process.platform !== 'win32' || !config.nativeHost) throw new Error('Worktree apply requires explicit policy and the native Windows host');
  requireCurrentWorktreeConfig(config);
  const selected = store.get('decision', text(decisionId, 'decision ID'))?.value;
  const project = config.projects.find(project => project.id === selected?.project);
  if (!project?.producerAdmission || selected.kind !== 'worktree' || selected.status !== 'eligible' || selected.id !== decisionId || selected.policyGeneration !== config.generation) throw new Error('A selected current eligible worktree decision is required');
  return beginQuarantine(config, store, selected, randomUUID(), Date.now(), (tx, originalPath) => {
    const checkout = managedCheckout(config, tx, project, originalPath, true);
    if (checkout.head !== selected.head || checkout.worktreeId !== selected.evidence.identity || !same(checkout.repositoryIncarnation, selected.evidence.repositoryIncarnation)) throw new Error('Worktree decision identity changed; scan again before applying');
    if (tx.list('action').some(({ value }) => holdsWorktreeRepository(value) && same(value.repositoryIncarnation, checkout.repositoryIncarnation))) throw new Error('A pending worktree action owns this repository');
    const { sourceInstance, issue } = selected.evidence.taskEvidence;
    const issueKey = digest([sourceInstance, issue]);
    const initialIssueRevision = tx.get('github_issue', issueKey)?.revision;
    if (!initialIssueRevision) throw new Error('Selected worktree issue snapshot unavailable');
    return { project: project.id, repositoryIncarnation: checkout.repositoryIncarnation, repositoryPaths: repositoryPaths(checkout), worktreeId: checkout.worktreeId, sourceInstance, issue, initialIssueRevision, retentionMs: config.policy.retentionMs };
  });
}

function pendingWorktree(config, store, actionId) {
  const owned = read(config, store, actionId, 'worktree');
  const { action } = owned;
  if (!['intent', 'prepared'].includes(action.phase) || action.command ||
      (action.phase === 'prepared' ? !action.containerIdentity || !action.quarantineIdentity : action.containerIdentity !== null || action.quarantineIdentity !== null) ||
      location(action) !== 'original') throw new Error('Unstarted worktree intent required');
  return owned;
}

export async function refreshWorktreeAuthority(config, store, actionId, request) {
  const { action } = pendingWorktree(config, store, actionId);
  const source = config.eventSources.find(source => source.instance === action.sourceInstance && source.github && source.projects[0] === action.project);
  if (!source || action.policyGeneration !== config.generation) throw new Error('Worktree configuration changed; scan again before applying');
  requireCurrentWorktreeConfig(config);
  const { issueRevision } = await syncGitHubIssueSnapshot(config, store, source.id, action.issue, request);
  return issueRevision;
}

export function verifyWorktreeAction(config, tx, actionId, issueRevision) {
  if (!tx.writing) throw new Error('Worktree authorization requires a write transaction');
  const { action } = pendingWorktree(config, tx, actionId);
  const project = config.projects.find(project => project.id === action.project);
  const selected = tx.get('decision', action.decisionId)?.value;
  if (!project || !selected || !config.policy.allowApply || action.policyGeneration !== config.generation || selected.policyGeneration !== config.generation) throw new Error('Worktree configuration or selection changed; scan again before applying');
  requireCurrentWorktreeConfig(config);
  const snapshot = tx.get('github_issue', digest([action.sourceInstance, action.issue]));
  if (snapshot?.revision !== issueRevision || !Number.isSafeInteger(issueRevision) || issueRevision <= action.initialIssueRevision || snapshot.value.readStartedAt < action.createdAt) throw new Error('Fresh GitHub issue snapshot superseded or unavailable');
  const { decisions: [fresh] } = scanProject(config, tx, project, Date.now(), action);
  if (fresh?.status !== 'eligible' || fresh.evidence.taskEvidence.issueRevision !== issueRevision) throw new Error(`Worktree no longer eligible: ${fresh?.reasons.join(', ') || 'observation unavailable'}`);
  const { id, evidence, ...decision } = fresh;
  const { observedAt, issueRevision: selectedRevision } = selected.evidence.taskEvidence;
  const comparison = { ...evidence, taskEvidence: { ...evidence.taskEvidence, observedAt, issueRevision: selectedRevision } };
  if (digest({ policy: config.generation, ...decision, evidence: comparison }) !== action.decisionId) throw new Error('Worktree decision changed; scan again before applying');
  const checkout = managedCheckout(config, tx, project, action.originalPath, true);
  if (checkout.head !== fresh.head || checkout.worktreeId !== action.worktreeId || !same(checkout.repositoryIncarnation, action.repositoryIncarnation) || location(action) !== 'original') throw new Error('Worktree identity changed during authorization');
  if (!same(repositoryPaths(checkout), action.repositoryPaths)) throw new Error('Repository checkout paths changed during authorization');
  requireCurrentWorktreeConfig(config);
  const now = Date.now();
  if (now < snapshot.value.observedAt || now - snapshot.value.readStartedAt > maxIssueAgeMs) throw new Error('Fresh GitHub issue snapshot expired during authorization');
  return fresh;
}

function worktreeRegistration(config, tx, action, root, fixedLayout = true) {
  const project = config.projects.find(project => project.id === action.project);
  if (!project) throw new Error('Worktree project unavailable during recovery');
  const checkout = managedCheckout(config, tx, project, root, true);
  const registration = checkout.worktrees.find(entry => path.relative(root, entry.path) === '');
  const paths = repositoryPaths(checkout);
  const expectedPaths = action.repositoryPaths.map(filename => filename === action.originalPath ? root : filename).sort();
  if (!registration || (registration.branch ?? null) !== action.command.branch || checkout.head !== action.command.head ||
      checkout.worktreeId !== action.worktreeId || !same(checkout.repositoryIncarnation, action.repositoryIncarnation) ||
      tx.get('identity', action.worktreeId)?.value.gitDir !== action.command.gitDir ||
      (fixedLayout && !same(paths, expectedPaths))) throw new Error('Worktree registration differs from the admitted checkout');
  return { registration, paths };
}

function reconcileWorktreeMove(config, tx, action, claim) {
  const receipt = readCommandCompletion(config, action.command.launch);
  if (!receipt) throw new Error('Native worktree move completion unavailable');
  const found = location(action);
  const root = found === 'original' ? action.originalPath : action.payloadPath;
  if (found === 'payload') recordRelocation(tx, action.worktreeId, root, action.command.gitDir);
  if (worktreeRegistration(config, tx, action, root).registration.locked) throw new Error('Worktree move registration unexpectedly locked');
  return complete(tx, { ...action, moveExitCode: receipt.exitCode }, claim, found === 'payload' ? 'moved' : 'cancelled');
}

const quarantineReason = action => `worktrunk-controller quarantine ${action.id}`;

function quarantineLock(action, registration) {
  const filename = path.join(action.command.gitDir, 'locked');
  const identity = at(filename);
  if (!identity && registration.locked === undefined) return null;
  const expected = Buffer.from(`${quarantineReason(action)}\n`);
  const stat = identity && fs.lstatSync(filename);
  if (registration.locked !== quarantineReason(action) || !stat?.isFile() || stat.nlink !== 1 ||
      stat.size !== expected.length || !fs.readFileSync(filename).equals(expected)) throw new Error('Worktree quarantine lock ownership differs');
  return identity;
}

function reconcileWorktreeLock(config, tx, action, claim) {
  const receipt = readCommandCompletion(config, action.lockCommand.launch);
  if (!receipt) throw new Error('Native worktree lock completion unavailable');
  if (location(action) !== 'payload') throw new Error('Worktree lock payload is unavailable');
  const { registration } = worktreeRegistration(config, tx, action, action.payloadPath);
  const identity = quarantineLock(action, registration);
  const next = { ...action, lockCommand: { ...action.lockCommand, exitCode: receipt.exitCode } };
  if (!identity && receipt.exitCode !== 0) return complete(tx, next, claim, 'moved');
  if (!identity || receipt.exitCode !== 0) throw new Error('Worktree quarantine lock outcome unavailable');
  const retentionClock = sampleClock();
  return complete(tx, { ...next, lockIdentity: identity, quarantinedAt: retentionClock.wallMs, retentionClock, retentionMs: action.retentionMs ?? config.policy.retentionMs }, claim, 'quarantined');
}

function reconcileWorktreeUnlock(config, tx, action, claim) {
  const receipt = readCommandCompletion(config, action.unlockCommand.launch);
  if (!receipt) throw new Error('Native worktree unlock completion unavailable');
  if (location(action) !== 'payload') throw new Error('Worktree unlock payload is unavailable');
  const { registration } = worktreeRegistration(config, tx, action, action.payloadPath);
  const identity = quarantineLock(action, registration);
  const next = { ...action, unlockCommand: { ...action.unlockCommand, exitCode: receipt.exitCode } };
  if (identity && same(identity, action.lockIdentity) && receipt.exitCode !== 0) return complete(tx, next, claim, 'quarantined');
  if (identity || receipt.exitCode !== 0) throw new Error('Worktree quarantine unlock outcome unavailable');
  return complete(tx, next, claim, 'unlocked');
}

function reconcileWorktreeRestore(config, tx, action, claim) {
  const receipt = readCommandCompletion(config, action.restoreCommand.launch);
  if (!receipt) throw new Error('Native worktree restore completion unavailable');
  const found = location(action);
  const root = found === 'original' ? action.originalPath : action.payloadPath;
  if (found === 'original') recordRelocation(tx, action.worktreeId, root, action.command.gitDir);
  const { registration } = worktreeRegistration(config, tx, action, root);
  if (quarantineLock(action, registration) || (receipt.exitCode === 0 && found !== 'original')) throw new Error('Worktree restore outcome unavailable');
  const next = { ...action, restoreCommand: { ...action.restoreCommand, exitCode: receipt.exitCode } };
  return complete(tx, next, claim, found === 'original' ? 'restored' : 'unlocked');
}

async function runWorktreeGit(config, store, action, args, authorize) {
  const project = config.projects.find(project => project.id === action.project);
  if (!project) throw new Error('Worktree project unavailable');
  const program = invocation(config, project.root, ({ git }) => localPath(path.join(git(['--exec-path']).trim(), 'git.exe')));
  const identity = fileIdentity(program), scope = openInvocation(config);
  await runJournaledCommand(config, store, { root: project.root, program, env: scope.env,
    args: isolatedGitArgs(scope.scratch, ['worktree', ...args]) }, (tx, launch) => {
    if (!same(fileIdentity(program), identity)) throw new Error('Git executable changed before worktree authorization');
    authorize(tx, launch);
  });
  const result = store.transaction(tx => reconcileWorktree(config, tx, read(config, tx, action.id, 'worktree')));
  scope.dispose();
  return result;
}

export async function moveWorktreeToQuarantine(config, store, decisionId, request) {
  const intent = beginWorktreeAction(config, store, decisionId);
  const id = intent.id;
  try {
    const issueRevision = await refreshWorktreeAuthority(config, store, id, request);
    store.transaction(tx => prepareQuarantine(tx, read(config, tx, id, 'worktree').action));
    const moved = await runWorktreeGit(config, store, intent, ['move', '--', intent.originalPath, intent.payloadPath], (tx, launch) => {
      const fresh = verifyWorktreeAction(config, tx, id, issueRevision);
      const { action } = read(config, tx, id, 'worktree');
      if (action.phase !== 'prepared') throw new Error('Worktree move preparation changed');
      tx.put('action', id, { ...action, phase: 'moving', command: { launch, head: fresh.head, branch: fresh.branch, gitDir: fresh.evidence.gitDir } });
    });
    if (moved.phase !== 'moved' || moved.moveExitCode !== 0) throw new Error('Git worktree move did not succeed');
    return moved;
  } catch (error) { return failed(config, store, id, error); }
}

export async function lockWorktreeQuarantine(config, store, id) {
  try {
    const { action } = read(config, store, id, 'worktree');
    const locked = await runWorktreeGit(config, store, action, ['lock', '--reason', quarantineReason(action), '--', action.payloadPath], (tx, launch) => {
      const { action } = read(config, tx, id, 'worktree');
      if (action.phase !== 'moved' || location(action) !== 'payload') throw new Error('Verified worktree move required before locking');
      const { registration } = worktreeRegistration(config, tx, action, action.payloadPath);
      if (registration.locked !== undefined || at(path.join(action.command.gitDir, 'locked'))) throw new Error('Worktree already locked');
      tx.put('action', id, { ...action, phase: 'locking', lockCommand: { launch } });
    });
    if (locked.phase !== 'quarantined') throw new Error('Git worktree lock did not succeed');
    return locked;
  } catch (error) { return failed(config, store, id, error); }
}

function unlockWorktreeForRestore(config, store, action) {
  const id = action.id;
  return runWorktreeGit(config, store, action, ['unlock', '--', action.payloadPath], (tx, launch) => {
    const { action, claim } = read(config, tx, id, 'worktree');
    if (action.phase !== 'quarantined' || location(action) !== 'payload') throw new Error('Verified worktree quarantine required before unlocking');
    const { registration, paths } = worktreeRegistration(config, tx, action, action.payloadPath, false);
    const identity = quarantineLock(action, registration);
    if (!identity || !same(identity, action.lockIdentity)) throw new Error('Worktree quarantine lock incarnation changed');
    if (paths.some(filename => filename !== action.payloadPath && (overlap(filename, action.originalPath) || overlap(filename, action.payloadPath)))) throw new Error('Worktree restore overlaps another checkout');
    const currentPaths = paths.map(filename => filename === action.payloadPath ? action.originalPath : filename).sort();
    tx.put('action', id, { ...action, phase: 'unlocking', repositoryPaths: currentPaths, unlockCommand: { launch } });
    verifyCleanupFences(tx, claim);
  });
}

export async function restoreWorktree(config, store, id) {
  try {
    const { action } = read(config, store, id, 'worktree');
    if (action.phase === 'restored') return action;
    const ready = action.phase === 'quarantined' ? await unlockWorktreeForRestore(config, store, action) : action;
    if (!['moved', 'unlocked'].includes(ready.phase)) throw new Error('Reconcile the pending worktree action before restoring');
    const restored = await runWorktreeGit(config, store, ready, ['move', '--', ready.payloadPath, ready.originalPath], (tx, launch) => {
      const { action } = read(config, tx, id, 'worktree');
      if (!['moved', 'unlocked'].includes(action.phase) || location(action) !== 'payload') throw new Error('Verified unlocked worktree required before restoring');
      const { registration } = worktreeRegistration(config, tx, action, action.payloadPath);
      if (quarantineLock(action, registration)) throw new Error('Worktree unexpectedly locked before restoring');
      tx.put('action', id, { ...action, phase: 'restoring', restoreCommand: { launch } });
    });
    if (restored.phase !== 'restored' || restored.restoreCommand.exitCode !== 0) throw new Error('Git worktree restore did not succeed');
    return restored;
  } catch (error) { return failed(config, store, id, error); }
}

export function quarantineArtifact(config, store, decisionId, now = Date.now()) {
  integer(now, 'action time', 1);
  if (!config.policy.allowApply) throw new Error('Apply is disabled by policy');
  const selected = store.get('decision', text(decisionId, 'decision ID'))?.value;
  if (!selected || selected.kind !== 'artifact' || selected.status !== 'eligible' || selected.policyGeneration !== config.generation) throw new Error('A selected current eligible artifact decision is required');
  const id = randomUUID();
  try {
    beginQuarantine(config, store, selected, id, now, () => ({ artifactId: selected.artifactId, projects: selected.projects }));
    store.transaction(tx => prepareQuarantine(tx, read(config, tx, id).action));
    return store.transaction(tx => {
      const { action, claim } = read(config, tx, id);
      if (action.phase !== 'prepared' || location(action) !== 'original') throw new Error('Quarantine is no longer prepared');
      const fresh = inspectArtifact(config, tx, action.artifactId, now, claim.token);
      if (fresh.status !== 'eligible' || fresh.id !== decisionId || action.policyGeneration !== config.generation) throw new Error('Artifact decision changed; scan again before applying');
      if (loadConfig(config.configPath).generation !== config.generation) throw new Error('Configuration changed; scan again before applying');
      fs.renameSync(action.originalPath, action.payloadPath);
      if (location(action) !== 'payload') throw new Error('Quarantine move outcome unavailable');
      const retentionClock = sampleClock();
      const baseline = { identity: fresh.evidence.identity, contents: fresh.evidence.contents };
      return complete(tx, { ...action, quarantinedAt: retentionClock.wallMs, retentionClock, baseline, retentionMs: config.artifactRoots.find(root => root.id === action.artifactId).retentionMs }, claim, 'quarantined');
    });
  } catch (error) { return failed(config, store, id, error); }
}

export function restore(config, store, actionId) {
  try {
    const pending = store.transaction(tx => {
      const { action } = read(config, tx, actionId);
      if (action.phase === 'restored') return action;
      if (action.phase !== 'quarantined' || location(action) !== 'payload') throw new Error('Reconcile the pending action before restoring');
      const next = { ...action, phase: 'restoring', error: null };
      tx.put('action', actionId, next);
      return next;
    });
    if (pending.phase === 'restored') return pending;
    return store.transaction(tx => {
      const { action, claim } = read(config, tx, actionId);
      if (action.phase !== 'restoring' || location(action) !== 'payload') throw new Error('Restore intent is no longer pending');
      fs.renameSync(action.payloadPath, action.originalPath);
      if (location(action) !== 'original') throw new Error('Restore move outcome unavailable');
      return complete(tx, action, claim, 'restored');
    });
  } catch (error) { return failed(config, store, actionId, error); }
}

function reviewQuarantine(config, store, actionId, clock, phase) {
  let action;
  let result;
  try {
    const owned = read(config, store, actionId); action = owned.action;
    if (action.phase !== phase || location(action) !== 'payload') throw new Error('Matching quarantined action required; reconcile pending outcomes');
    const artifact = config.artifactRoots.find(root => root.id === action.artifactId && root.path === action.originalPath);
    if (!artifact) throw new Error('Artifact configuration no longer matches action');
    const fresh = inspectArtifact(config, store, action.artifactId, clock?.wallMs ?? Date.now(), owned.claim.token);
    const reasons = [...fresh.reasons];
    if (!action.baseline || !same(action.baseline, { identity: fresh.evidence?.identity ?? null, contents: fresh.evidence?.contents ?? null })) reasons.push('quarantine_baseline_changed_or_unknown');
    const retentionMs = Math.max(action.retentionMs ?? NaN, artifact.retentionMs);
    const retention = retentionStatus(action.retentionClock, clock, retentionMs);
    if (retention) reasons.push(retention);
    if (action.purgeOutcome === 'interrupted') reasons.push('interrupted_purge_restore_only');
    result = { status: fresh.status === 'analysis_failed' ? 'analysis_failed' : reasons.length ? 'retain' : 'eligible', reasons, evidence: { artifact: fresh.evidence, baseline: action.baseline ?? null, retentionClock: action.retentionClock ?? null, retentionMs, incarnation: action.incarnation, containerIdentity: action.containerIdentity, claimToken: action.claimToken } };
    // NaN is not persistent evidence: legacy manifests remain explicitly unknown.
    if (!Number.isSafeInteger(retentionMs)) result.evidence.retentionMs = null;
  } catch (error) { result = { status: 'analysis_failed', reasons: ['quarantine_observation_unavailable'], evidence: null, error: error.message }; }
  const decision = { kind: 'artifact_purge', actionId, artifactId: action?.artifactId ?? null, projects: action?.projects ?? [], path: action?.payloadPath ?? null, ...result };
  return { ...decision, id: digest({ policy: config.generation, ...decision }) };
}

export function inspectQuarantine(config, store, actionId, clock = sampleClock()) {
  return store.transaction(tx => reviewQuarantine(config, tx, actionId, clock, 'quarantined'));
}

export function purgeArtifact(config, store, decisionId) {
  if (!config.policy.allowApply) throw new Error('Purge is disabled by policy');
  const selected = store.get('decision', text(decisionId, 'decision ID'))?.value;
  if (!selected || selected.kind !== 'artifact_purge' || selected.status !== 'eligible' || selected.policyGeneration !== config.generation) throw new Error('A selected current eligible artifact purge decision is required');
  const id = selected.actionId;
  try {
    store.transaction(tx => {
      const { action, claim } = read(config, tx, id);
      const fresh = reviewQuarantine(config, tx, id, sampleClock(), 'quarantined');
      if (fresh.status !== 'eligible' || fresh.id !== decisionId) throw new Error('Purge decision changed; scan again before purging');
      complete(tx, { ...action, purgeOutcome: 'pending' }, claim, 'purging');
    });
    return store.transaction(tx => {
      const { action, claim } = read(config, tx, id);
      const fresh = reviewQuarantine(config, tx, id, sampleClock(), 'purging');
      if (fresh.status !== 'eligible' || fresh.id !== decisionId) throw new Error('Purge decision changed; reconcile before retrying');
      if (loadConfig(config.configPath).generation !== config.generation) throw new Error('Configuration changed; reconcile before purging');
      for (const name of fs.readdirSync(action.payloadPath).sort()) fs.rmSync(path.join(action.payloadPath, name), { recursive: true });
      if (location(action) !== 'payload' || fs.readdirSync(action.payloadPath).length) throw new Error('Purge reset boundary changed');
      fs.renameSync(action.payloadPath, action.originalPath);
      if (location(action) !== 'original' || fs.readdirSync(action.originalPath).length) throw new Error('Purge reset outcome unavailable');
      return complete(tx, { ...action, purgeOutcome: 'complete', purgedAt: Date.now() }, claim, 'purged');
    });
  } catch (error) { return failed(config, store, id, error); }
}

function reconcileWorktree(config, tx, { action, claim }) {
  if (terminal.has(action.phase)) return action;
  if (action.phase === 'moving') return reconcileWorktreeMove(config, tx, action, claim);
  if (action.phase === 'locking') return reconcileWorktreeLock(config, tx, action, claim);
  if (action.phase === 'unlocking') return reconcileWorktreeUnlock(config, tx, action, claim);
  if (action.phase === 'restoring') return reconcileWorktreeRestore(config, tx, action, claim);
  if (['moved', 'quarantined', 'unlocked'].includes(action.phase) && location(action) === 'payload') {
    const { registration } = worktreeRegistration(config, tx, action, action.payloadPath, action.phase !== 'quarantined');
    const identity = quarantineLock(action, registration);
    if (action.phase === 'quarantined' ? !identity || !same(identity, action.lockIdentity) : identity) throw new Error('Worktree quarantine lock incarnation changed');
    return action;
  }
  pendingWorktree(config, tx, action.id);
  return complete(tx, action, claim, 'cancelled');
}

export function reconcile(config, store, actionId) {
  try {
    return store.transaction(tx => {
      if (tx.get('action', text(actionId, 'action ID'))?.value.kind === 'worktree') {
        return reconcileWorktree(config, tx, read(config, tx, actionId, 'worktree'));
      }
      const { action, claim } = read(config, tx, actionId);
      if (terminal.has(action.phase)) return action;
      const found = location(action);
      if (action.phase === 'purging') {
        if (found === 'original') {
          if (fs.readdirSync(action.originalPath).length) throw new Error('Purge reset root is not empty');
          return complete(tx, { ...action, purgeOutcome: 'complete', purgedAt: null }, claim, 'purged');
        }
        return complete(tx, { ...action, purgeOutcome: 'interrupted', retentionClock: null }, claim, 'quarantined');
      }
      if (action.phase === 'restoring') return complete(tx, action, claim, found === 'original' ? 'restored' : 'quarantined');
      if (action.phase === 'quarantined' && found !== 'payload') throw new Error('Completed quarantine changed outside the controller');
      return complete(tx, action, claim, found === 'payload' ? 'quarantined' : 'cancelled');
    });
  } catch (error) { return failed(config, store, actionId, error); }
}
