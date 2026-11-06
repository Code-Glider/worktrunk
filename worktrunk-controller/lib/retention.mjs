import os from 'node:os';

export function sampleClock() {
  const before = Math.floor(os.uptime()) * 1000;
  const wallMs = Date.now();
  const after = (Math.floor(os.uptime()) + 1) * 1000;
  return { wallMs, before, after };
}

export function retentionStatus(start, current, retentionMs) {
  const valid = value => value && ['wallMs', 'before', 'after'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0) && value.before < value.after && value.after - value.before <= 2000;
  if (!valid(start) || !valid(current) || !Number.isSafeInteger(retentionMs) || retentionMs < 1) return 'retention_clock_unknown';
  const wall = current.wallMs - start.wallMs;
  // Uptime brackets are conservative across rounding and reboot; wall time alone cannot expire data.
  const lower = Math.max(0, current.before - start.after), upper = current.after - start.before;
  if (wall < 0 || wall < lower || wall > upper) return 'retention_clock_uncertain';
  return Math.min(wall, lower) >= retentionMs ? null : 'retention_pending';
}
