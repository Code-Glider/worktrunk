import { randomUUID } from 'node:crypto';
import { digest, text } from './data.mjs';
import { fileIdentity, localPath, overlap } from './paths.mjs';

function roots(paths) {
  if (!Array.isArray(paths) || !paths.length) throw new Error('Claims require explicit roots');
  const result = paths.map(value => { const path = localPath(value); return { path, incarnation: fileIdentity(path) }; });
  if (new Set(result.map(root => root.path)).size !== result.length) throw new Error('Duplicate claim root');
  return result;
}

function fences(tx, claim, root) {
  const result = [root.path];
  if (claim.actionId) {
    const action = tx.get('action', claim.actionId)?.value;
    if (claim.kind !== 'cleanup' || claim.roots.length !== 1 || !action || action.id !== claim.actionId || action.claimToken !== claim.token || action.owner !== claim.owner || action.originalPath !== root.path || digest(action.incarnation) !== digest(root.incarnation)) throw new Error('Cleanup action binding unavailable');
    if (digest(fileIdentity(path.dirname(root.path))) !== digest(action.originalParent)) throw new Error('Cleanup parent changed');
    const containerPath = localPath(action.containerPath, { missing: true });
    result.push(containerPath);
    if (action.containerIdentity) {
      if (digest(fileIdentity(containerPath)) !== digest(action.containerIdentity)) throw new Error('Cleanup container changed');
    } else if (fs.existsSync(containerPath)) throw new Error('Cleanup container is unverified');
    if (root.currentPath && (root.currentPath !== action.payloadPath || path.dirname(root.currentPath) !== action.containerPath || !['quarantined', 'restoring', 'purging'].includes(action.phase))) throw new Error('Cleanup relocation unavailable');
  } else if (root.currentPath) throw new Error('Cleanup relocation has no action');
  if (digest(fileIdentity(root.currentPath ?? root.path)) !== digest(root.incarnation)) throw new Error('Claim incarnation changed');
  return result;
}

function conflicts(tx, targets, cleanup, ownToken) {
  return tx.list('claim').some(({ value }) => value.state !== 'released' && value.state !== 'ended' && (cleanup || value.kind === 'cleanup') && value.roots.some(root => {
    // Only a journaled move has known ancestry; unexplained movement blocks globally.
    let paths;
    try { paths = fences(tx, value, root); }
    catch { return true; }
    if (value.token === ownToken) return false;
    return paths.some(path => targets.some(target => overlap(path, target.path)));
  }));
}

export function checkoutProducerFence(producers, checkout, exceptToken) {
  return digest(producers.filter(claim => claim.token !== exceptToken && claim.roots.some(root =>
    overlap(root.path, checkout.path) || digest(root.incarnation) === digest(checkout.incarnation)
  )).map(claim => claim.token).sort());
}

export function endedManagedLaunch(claim, now) {
  return claim.kind === 'producer' && claim.state === 'ended' && Boolean(claim.task) &&
    claim.evidence?.kind === 'windows_job' && claim.evidence.launchToken === claim.token && claim.evidence.activeProcesses === 1 &&
    /^[a-f0-9]{40}$/.test(claim.endedHead ?? '') && Number.isSafeInteger(claim.admittedAt) && Number.isSafeInteger(claim.endedAt) &&
    claim.admittedAt >= 0 && claim.endedAt >= claim.admittedAt && claim.endedAt <= now;
}

export function acceptanceMatchesLaunch(event, claim) {
  const task = claim.task;
  return event.attemptId === String(task.attempt) && event.attemptNumber === task.attempt && event.sourceInstance === task.sourceInstance &&
    event.project === task.project && event.authorityProject === task.authorityProject && event.taskId === task.taskId &&
    event.head === claim.endedHead && event.at >= claim.endedAt;
}

export function reserve(store, request) {
  const targets = roots(request.roots), owner = text(request.owner, 'owner'), sessionId = text(request.sessionId, 'sessionId');
  return store.transaction(tx => {
    if (conflicts(tx, targets, false)) throw new Error('Cleanup claim blocks producer admission');
    const task = request.task;
    const producers = tx.list('claim').map(row => row.value).filter(claim => claim.kind === 'producer');
    if (task && producers.some(claim => claim.task?.taskKey === task.taskKey && claim.task.attempt === task.attempt)) throw new Error('GitHub issue attempt already has a launch claim');
    if (task && producers.some(claim => claim.task?.taskKey === task.taskKey && claim.task.attempt > task.attempt)) throw new Error('GitHub issue newer attempt already has a launch claim');
    if (producers.some(claim => {
      if (claim.state === 'ended') return false;
      try {
        return (task && claim.roots.some(root => fences(tx, claim, root).some(path => overlap(path, targets[0].path)))) ||
          (claim.task && fences(tx, claim, claim.roots[0]).some(path => targets.some(root => overlap(path, root.path))));
      } catch { return true; }
    })) throw new Error('A managed task requires exclusive producer admission for its checkout');
    const token = randomUUID();
    const record = { version: 1, token, kind: 'producer', state: 'reserved', owner, sessionId, roots: targets, evidence: null };
    if (task) {
      record.task = task;
      record.priorProducerFence = checkoutProducerFence(producers, targets[0]);
    }
    tx.put('claim', token, record);
    return record;
  });
}

const transitions = { reserved: ['starting'], starting: ['running', 'unresolved'], running: ['ended', 'unresolved'] };

export function transition(store, token, expected, next, nativeEvidence, endedHead) {
  return store.transaction(tx => {
    const record = tx.get('claim', text(token, 'claim token'))?.value;
    if (!record || record.kind !== 'producer' || record.state !== expected || !transitions[expected]?.includes(next)) throw new Error('Invalid producer transition');
    if (next === 'running' || next === 'ended') {
      if (nativeEvidence?.launchToken !== token || nativeEvidence.kind !== 'windows_job' || nativeEvidence.helperPid < 1 || !Number.isSafeInteger(nativeEvidence.helperPid)) throw new Error('Native launch evidence required');
      if (next === 'ended' && (nativeEvidence.activeProcesses !== 1 || digest(record.evidence) !== digest({ ...nativeEvidence, activeProcesses: null }))) throw new Error('Native job completion does not match admitted lifetime');
    }
    const value = { ...record, state: next, evidence: nativeEvidence ?? record.evidence };
    if (record.task && next === 'running') value.admittedAt = Date.now();
    if (record.task && next === 'ended') {
      if (!/^[a-f0-9]{40}$/.test(endedHead ?? '')) throw new Error('Managed task completion requires a full GitHub commit ID');
      value.endedAt = Date.now();
      value.endedHead = endedHead;
    }
    tx.put('claim', token, value);
    return value;
  });
}

export function acquireCleanup(store, request, onAcquire = () => {}) {
  const targets = roots(request.roots), owner = text(request.owner, 'owner');
  return store.transaction(tx => {
    if (conflicts(tx, targets, true)) throw new Error('Active or unresolved owner/cleanup claim');
    const token = randomUUID();
    const record = { version: 1, token, kind: 'cleanup', state: 'held', owner, roots: targets };
    if (request.actionId !== undefined) record.actionId = text(request.actionId, 'action ID');
    tx.put('claim', token, record);
    if (onAcquire(tx, record)?.then) throw new Error('Cleanup intent callback must be synchronous');
    const fenced = targets.flatMap(root => fences(tx, record, root).map(path => ({ path })));
    if (conflicts(tx, fenced, true, token)) throw new Error('Active or unresolved owner/cleanup claim');
    return record;
  });
}

export function releaseCleanup(store, token) {
  return store.transaction(tx => {
    const record = tx.get('claim', text(token, 'claim token'))?.value;
    if (!record || record.kind !== 'cleanup' || record.state !== 'held') throw new Error('Cleanup claim is not held');
    if (record.actionId) throw new Error('Action cleanup claims require verified action recovery');
    tx.put('claim', token, { ...record, state: 'released' });
  });
}

export function inactive(store, root, ownCleanupToken) {
  const targets = roots([root]);
  if (ownCleanupToken !== undefined) {
    const claim = store.get('claim', ownCleanupToken)?.value;
    const action = claim?.actionId && store.get('action', claim.actionId)?.value;
    if (!claim || claim.kind !== 'cleanup' || claim.state !== 'held' || claim.roots.length !== 1 || (claim.roots[0].currentPath ?? claim.roots[0].path) !== targets[0].path || !action || !(claim.roots[0].currentPath ? ['quarantined', 'purging'] : ['intent', 'prepared']).includes(action.phase)) throw new Error('Own cleanup claim does not match action');
    fences(store, claim, claim.roots[0]);
  }
  return !conflicts(store, targets, true, ownCleanupToken);
}
import fs from 'node:fs';
import path from 'node:path';
