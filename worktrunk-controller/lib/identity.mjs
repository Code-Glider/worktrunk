import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, object } from './data.mjs';
import { fileIdentity, localPath } from './paths.mjs';

function evidence(root, gitDir, marker) {
  return { root: fileIdentity(root), gitDir: fileIdentity(gitDir), marker: fileIdentity(marker) };
}

export function inspectIdentity(store, root, gitDir, kind = 'worktree') {
  const marker = path.join(localPath(gitDir), `worktrunk-controller-${kind}.json`);
  let value;
  try { value = object(JSON.parse(fs.readFileSync(localPath(marker), 'utf8')), 'enrollment'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (value.version !== 1 || value.kind !== kind || typeof value.id !== 'string') throw new Error('Invalid enrollment marker');
  const record = store.get('identity', value.id);
  if (!record || record.value.path !== localPath(root) || record.value.gitDir !== localPath(gitDir)) return null;
  return digest(record.value.evidence) === digest(evidence(root, gitDir, marker)) ? record : null;
}

export function enroll(store, root, gitDir, kind = 'worktree', now = Date.now()) {
  if (!['worktree', 'repository'].includes(kind)) throw new Error('Unsupported enrollment kind');
  root = localPath(root); gitDir = localPath(gitDir);
  if (inspectIdentity(store, root, gitDir, kind)) throw new Error('Already enrolled');
  const marker = path.join(gitDir, `worktrunk-controller-${kind}.json`);
  const key = digest({ root, gitDir, kind });
  const pending = store.transaction(tx => {
    const old = tx.get('enrollment', key);
    if (old) return old.value;
    const value = { version: 1, id: randomUUID(), kind, path: root, gitDir, enrolledAt: now, rootEvidence: fileIdentity(root), gitEvidence: fileIdentity(gitDir), state: 'pending' };
    tx.put('enrollment', key, value);
    return value;
  });
  if (pending.state !== 'pending' || digest(pending.rootEvidence) !== digest(fileIdentity(root)) || digest(pending.gitEvidence) !== digest(fileIdentity(gitDir))) throw new Error('Enrollment incarnation changed; explicit repair required');
  const id = pending.id;
  try {
    const fd = fs.openSync(marker, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ version: 1, kind, id })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const old = JSON.parse(fs.readFileSync(localPath(marker), 'utf8'));
    if (old.version !== 1 || old.kind !== kind || old.id !== id) throw new Error('Conflicting enrollment marker; explicit repair required');
  }
  const value = { version: 1, id, kind, path: root, gitDir, enrolledAt: pending.enrolledAt, evidence: evidence(root, gitDir, marker) };
  if (digest(pending.rootEvidence) !== digest(value.evidence.root) || digest(pending.gitEvidence) !== digest(value.evidence.gitDir)) throw new Error('Enrollment incarnation changed before commit');
  store.transaction(tx => {
    if (tx.get('enrollment', key)?.value.state !== 'pending') throw new Error('Enrollment already completed');
    tx.put('identity', id, value);
    tx.put('enrollment', key, { ...pending, state: 'enrolled' });
  });
  return value;
}

export function recordRelocation(store, id, newRoot, newGitDir) {
  const old = store.get('identity', id);
  if (!old) throw new Error('Unknown identity');
  const marker = path.join(localPath(newGitDir), `worktrunk-controller-${old.value.kind}.json`);
  if (digest(old.value.evidence) !== digest(evidence(newRoot, newGitDir, marker))) throw new Error('Relocation changed incarnation');
  store.transaction(tx => tx.put('identity', id, { ...old.value, path: localPath(newRoot), gitDir: localPath(newGitDir) }));
}
