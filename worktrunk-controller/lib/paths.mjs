import fs from 'node:fs';
import path from 'node:path';
import { text } from './data.mjs';

export function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function overlap(a, b) { return within(a, b) || within(b, a); }

// Reject links at every boundary component, including Windows junctions.
export function localPath(value, { missing = false } = {}) {
  text(value, 'path');
  if (!path.isAbsolute(value) || /^[/\\]{2}/.test(value)) throw new Error('Expected an absolute local path');
  const resolved = path.resolve(value);
  const root = path.parse(resolved).root;
  let cursor = root;
  let absent = false;
  for (const part of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (absent) continue;
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`Link traversal refused: ${cursor}`);
    } catch (error) {
      if (missing && error.code === 'ENOENT') absent = true;
      else throw error;
    }
  }
  return absent ? resolved : fs.realpathSync.native(resolved);
}

export function fileIdentity(value) {
  const canonical = localPath(value);
  const stat = fs.statSync(canonical, { bigint: true });
  if (stat.ino === 0n || stat.birthtimeNs <= 0n) throw new Error('Native incarnation evidence unavailable');
  return { dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) };
}
