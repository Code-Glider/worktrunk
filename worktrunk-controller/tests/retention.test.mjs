import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { sampleClock, retentionStatus } from '../lib/retention.mjs';

const start = { wallMs: 100000, before: 50000, after: 51000 };
const sample = elapsed => ({ wallMs: 100000 + elapsed, before: 50000 + elapsed, after: 51000 + elapsed });

test('retention uses the elapsed lower bound, including the exact threshold', () => {
  assert.equal(retentionStatus(start, sample(5999), 5000), 'retention_pending');
  assert.equal(retentionStatus(start, sample(6000), 5000), null);
  assert.equal(retentionStatus(start, sample(6000), 5001), 'retention_pending');
});

test('wall jumps, reboot uncertainty and missing or delayed samples retain', () => {
  for (const current of [
    { ...sample(10000), wallMs: 99999 },
    { ...sample(10000), wallMs: 1000000 },
    { ...sample(10000), before: 1000, after: 2000 },
    { ...sample(100000), before: 60000, after: 61000 },
  ]) assert.equal(retentionStatus(start, current, 5000), 'retention_clock_uncertain');
  for (const current of [null, {}, { ...sample(10000), wallMs: NaN }, { ...sample(10000), after: 64000 }]) assert.equal(retentionStatus(start, current, 5000), 'retention_clock_unknown');
  assert.equal(retentionStatus(null, sample(10000), 5000), 'retention_clock_unknown');
  assert.equal(retentionStatus(start, sample(10000), 0), 'retention_clock_unknown');
});

test('real separate Node processes use the same increasing uptime basis', () => {
  const before = sampleClock();
  const source = new URL('../lib/retention.mjs', import.meta.url).href;
  const child = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `import { sampleClock } from ${JSON.stringify(source)}; process.stdout.write(JSON.stringify(sampleClock()));`], { encoding: 'utf8', windowsHide: true }));
  const after = sampleClock();
  assert.ok(before.before <= child.before && child.before <= after.after);
  assert.ok(before.wallMs <= child.wallMs && child.wallMs <= after.wallMs);
  assert.equal(retentionStatus(before, after, 3600000), 'retention_pending');
});
