import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { digest } from './data.mjs';
import { fileIdentity, localPath } from './paths.mjs';

export function verifyNativeHost(config) {
  if (process.platform !== 'win32' || config.nativeHost?.version !== 1) throw new Error('Qualified native Windows lifetime host required');
  const path = localPath(config.nativeHost.path), incarnation = fileIdentity(path);
  const hash = () => createHash('sha256').update(fs.readFileSync(path)).digest('hex');
  if (hash() !== config.nativeHost.sha256) throw new Error('Native host executable hash changed');
  const version = spawnSync(path, ['--version'], { windowsHide: true, encoding: 'utf8', timeout: config.limits.timeoutMs });
  if (version.status !== 0 || version.stdout.trim() !== 'wt-controller-host 1') throw new Error('Unsupported native host protocol');
  if (digest(incarnation) !== digest(fileIdentity(path)) || hash() !== config.nativeHost.sha256) throw new Error('Native host executable changed during verification');
  return { path, incarnation, sha256: config.nativeHost.sha256, version: 1 };
}
