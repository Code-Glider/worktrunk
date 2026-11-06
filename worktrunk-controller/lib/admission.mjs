import { randomUUID } from 'node:crypto';
import { digest, text } from './data.mjs';
import { fileIdentity, localPath, overlap } from './paths.mjs';

function roots(paths) {
  if (!Array.isArray(paths) || !paths.length) throw new Error('Claims require explicit roots');
  const result = paths.map(value => { const path = localPath(value); return { path, incarnation: fileIdentity(path) }; });
  if (new Set(result.map(root => root.path)).size !== result.length) throw new Error('Duplicate claim root');
  return result;
}

function conflicts(tx, targets, cleanup) {
  return tx.list('claim').some(({ value }) => value.state !== 'released' && value.state !== 'ended' && (cleanup || value.kind === 'cleanup') && value.roots.some(root => {
    // A moved/missing root has unknown ancestry; its old path cannot fence cleanup.
    try { if (digest(fileIdentity(root.path)) !== digest(root.incarnation)) return true; }
    catch { return true; }
    return targets.some(target => overlap(root.path, target.path));
  }));
}

export function reserve(store, request) {
  const targets = roots(request.roots), owner = text(request.owner, 'owner'), sessionId = text(request.sessionId, 'sessionId');
  return store.transaction(tx => {
    if (conflicts(tx, targets, false)) throw new Error('Cleanup claim blocks producer admission');
    const token = randomUUID();
    const record = { version: 1, token, kind: 'producer', state: 'reserved', owner, sessionId, roots: targets, evidence: null };
    tx.put('claim', token, record);
    return record;
  });
}

const transitions = { reserved: ['starting'], starting: ['running', 'unresolved'], running: ['ended', 'unresolved'] };

export function transition(store, token, expected, next, nativeEvidence) {
  return store.transaction(tx => {
    const record = tx.get('claim', text(token, 'claim token'))?.value;
    if (!record || record.kind !== 'producer' || record.state !== expected || !transitions[expected]?.includes(next)) throw new Error('Invalid producer transition');
    if (next === 'running' || next === 'ended') {
      if (nativeEvidence?.launchToken !== token || nativeEvidence.kind !== 'windows_job' || nativeEvidence.helperPid < 1 || !Number.isSafeInteger(nativeEvidence.helperPid)) throw new Error('Native launch evidence required');
      if (next === 'ended' && (nativeEvidence.activeProcesses !== 1 || digest(record.evidence) !== digest({ ...nativeEvidence, activeProcesses: null }))) throw new Error('Native job completion does not match admitted lifetime');
    }
    const value = { ...record, state: next, evidence: nativeEvidence ?? record.evidence };
    tx.put('claim', token, value);
    return value;
  });
}

export function acquireCleanup(store, request) {
  const targets = roots(request.roots), owner = text(request.owner, 'owner');
  return store.transaction(tx => {
    if (conflicts(tx, targets, true)) throw new Error('Active or unresolved owner/cleanup claim');
    const token = randomUUID();
    const record = { version: 1, token, kind: 'cleanup', state: 'held', owner, roots: targets };
    tx.put('claim', token, record);
    return record;
  });
}

export function releaseCleanup(store, token) {
  return store.transaction(tx => {
    const record = tx.get('claim', text(token, 'claim token'))?.value;
    if (!record || record.kind !== 'cleanup' || record.state !== 'held') throw new Error('Cleanup claim is not held');
    tx.put('claim', token, { ...record, state: 'released' });
  });
}

export function inactive(store, root) {
  const targets = roots([root]);
  return !conflicts(store, targets, true);
}
