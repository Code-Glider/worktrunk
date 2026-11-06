// Intent, container preparation and move commit separately. A SQLite write lock
// serializes every filesystem step with restore/reconcile; uncertain moves retain claims.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, integer, text } from './data.mjs';
import { fileIdentity, localPath } from './paths.mjs';
import { acquireCleanup } from './admission.mjs';
import { inspectArtifact } from './artifacts.mjs';
import { loadConfig } from './config.mjs';
import { sampleClock, retentionStatus } from './retention.mjs';

const terminal = new Set(['restored', 'cancelled', 'purged']);
const same = (a, b) => digest(a) === digest(b);

function at(filename) {
  localPath(filename, { missing: true });
  try { return fileIdentity(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function read(config, tx, id) {
  const action = tx.get('action', text(id, 'action ID'))?.value;
  if (!action || action.kind !== 'artifact' || action.id !== id || !/^[a-f0-9-]{36}$/.test(id) || action.owner !== config.host.id || action.domain !== process.platform) throw new Error('Matching owned artifact action required');
  if (!['intent', 'prepared', 'quarantined', 'restoring', 'restored', 'cancelled', 'purging', 'purged'].includes(action.phase)) throw new Error('Unsupported action phase');
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
  tx.put('claim', claim.token, { ...claim, state: terminal.has(phase) ? 'released' : 'held', roots: [{ path: action.originalPath, incarnation: action.incarnation, ...(['quarantined', 'purging'].includes(phase) ? { currentPath: action.payloadPath } : {}) }] });
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

export function quarantineArtifact(config, store, decisionId, now = Date.now()) {
  integer(now, 'action time', 1);
  if (!config.policy.allowApply) throw new Error('Apply is disabled by policy');
  const selected = store.get('decision', text(decisionId, 'decision ID'))?.value;
  if (!selected || selected.kind !== 'artifact' || selected.status !== 'eligible' || selected.policyGeneration !== config.generation) throw new Error('A selected current eligible artifact decision is required');
  const id = randomUUID(), containerPath = path.join(config.quarantineDir, id);
  try {
    acquireCleanup(store, { roots: [selected.path], owner: config.host.id, actionId: id }, (tx, claim) => {
      tx.put('action', id, {
        version: 1, id, kind: 'artifact', artifactId: selected.artifactId, projects: selected.projects, owner: config.host.id, domain: process.platform,
        claimToken: claim.token, decisionId, policyGeneration: config.generation,
        originalPath: selected.path, incarnation: selected.evidence.incarnation, originalParent: fileIdentity(path.dirname(selected.path)),
        quarantineRoot: config.quarantineDir, quarantineParent: fileIdentity(path.dirname(config.quarantineDir)), quarantineIdentity: null,
        containerPath, containerIdentity: null, payloadPath: path.join(containerPath, 'payload'),
        phase: 'intent', createdAt: now, quarantinedAt: null, error: null,
      });
    });
    store.transaction(tx => {
      const { action } = read(config, tx, id);
      if (action.phase !== 'intent' || location(action) !== 'original') throw new Error('Quarantine intent is no longer pending');
      try { fs.mkdirSync(action.quarantineRoot, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const quarantineIdentity = fileIdentity(action.quarantineRoot);
      if (!fs.statSync(action.quarantineRoot).isDirectory() || quarantineIdentity.dev !== action.incarnation.dev) throw new Error('Quarantine must be a directory on the same filesystem');
      fs.mkdirSync(action.containerPath, { mode: 0o700 });
      tx.put('action', id, { ...action, phase: 'prepared', quarantineIdentity, containerIdentity: fileIdentity(action.containerPath) });
    });
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

export function reconcile(config, store, actionId) {
  try {
    return store.transaction(tx => {
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
