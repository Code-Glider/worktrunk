import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { controller, fixture, git, nativeWorktrunk } from './helpers.mjs';
import { Store } from '../lib/store.mjs';

const runner = fileURLToPath(new URL('../scheduling/scan-report.ps1', import.meta.url));
const windows = process.platform === 'win32';
const pwsh = process.env.PWSH_PATH ?? 'pwsh';
const binary = windows ? nativeWorktrunk() : null;

test('Windows scheduler example parses with disabled least-privilege observation settings', { skip: !windows, timeout: 30000 }, t => {
  const root = fixture(t), inspect = path.join(root, 'inspect.ps1');
  const xmlPath = fileURLToPath(new URL('../scheduling/scan-report-task.example.xml', import.meta.url));
  fs.writeFileSync(inspect, `param([string]$XmlPath, [string]$Runner)
    $ErrorActionPreference = 'Stop'
    $tokens = $null; $errors = $null
    [Management.Automation.Language.Parser]::ParseFile($Runner, [ref]$tokens, [ref]$errors) > $null
    if ($errors.Count) { throw ($errors | Out-String) }
    [xml]$xml = Get-Content -LiteralPath $XmlPath -Raw
    $settings = @{}; $principal = @{}; $action = @{}
    foreach ($element in $xml.Task.Settings.ChildNodes) { $settings[$element.LocalName] = $element.InnerText }
    foreach ($element in $xml.Task.Principals.Principal.ChildNodes) { $principal[$element.LocalName] = $element.InnerText }
    foreach ($element in $xml.Task.Actions.Exec.ChildNodes) { $action[$element.LocalName] = $element.InnerText }
    [ordered]@{ settings = $settings; principal = $principal; action = $action; start = $xml.Task.Triggers.CalendarTrigger.StartBoundary; interval = $xml.Task.Triggers.CalendarTrigger.ScheduleByDay.DaysInterval } | ConvertTo-Json -Depth 5`);
  const result = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', inspect, '-XmlPath', xmlPath, '-Runner', runner], { encoding: 'utf8', windowsHide: true, timeout: 25000 });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.settings.Enabled, 'false'); assert.equal(value.settings.MultipleInstancesPolicy, 'IgnoreNew');
  assert.equal(value.settings.ExecutionTimeLimit, 'PT16M'); assert.equal(value.settings.AllowHardTerminate, 'true');
  assert.equal(value.principal.RunLevel, 'LeastPrivilege'); assert.equal(value.principal.LogonType, 'InteractiveToken');
  assert.equal(value.interval, '1'); assert.equal(value.start, '2026-01-01T03:00:00');
  assert.match(value.action.Command, /pwsh\.exe$/); assert.match(value.action.Arguments, /scan-report\.ps1/);
  assert.match(value.action.Arguments, /-TimeoutSeconds 900/); assert.doesNotMatch(value.action.Arguments, /\b(apply|purge|enroll|reconcile|Bypass|SyncGitHubIssues)\b/);
});

function launch(script, config, timeout = 20, node = process.execPath) {
  const child = spawn(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, '-Node', node, '-Config', config, '-TimeoutSeconds', String(timeout)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  return { child, done: once(child, 'exit').then(([code]) => ({ code, stdout, stderr })) };
}

async function waitFor(filename, child, timeout = 15000) {
  const until = Date.now() + timeout;
  while (!fs.existsSync(filename)) {
    assert.equal(child.exitCode, null, 'runner exited before fixture checkpoint');
    assert.ok(Date.now() < until, `fixture checkpoint missing: ${filename}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function scripted(t, body) {
  const root = fixture(t), scheduling = path.join(root, 'scheduling'), bin = path.join(root, 'bin');
  fs.mkdirSync(scheduling); fs.mkdirSync(bin);
  const script = path.join(scheduling, 'scan-report.ps1'), config = path.join(root, 'config space א.json');
  fs.copyFileSync(runner, script); fs.writeFileSync(config, '{}');
  fs.writeFileSync(path.join(bin, 'controller.mjs'), `import fs from 'node:fs'; import path from 'node:path'; import { spawn } from 'node:child_process';
    const args = process.argv.slice(2), root = path.dirname(args[args.indexOf('--config') + 1]);
    fs.appendFileSync(path.join(root, 'calls'), JSON.stringify(args) + '\\n');
    ${body}`);
  return { root, script, config, calls: () => fs.readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n').map(JSON.parse) };
}

test('Windows scan/report repeated fresh invocations preserve real worktree content and report state', { skip: !windows, timeout: 60000 }, async t => {
  const s = controller(t, binary), config = path.join(s.base, 'config space א.json');
  fs.renameSync(s.filename, config);
  git(s.root, 'config', 'worktrunk.default-branch', 'main');
  const sentinel = path.join(s.root, 'unique.txt'); fs.writeFileSync(sentinel, 'unfinished work');
  const head = git(s.root, 'rev-parse', 'HEAD'), index = fs.readFileSync(path.join(s.gitDir, 'index'));
  for (let i = 0; i < 2; i++) {
    const result = await launch(runner, config).done;
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /worktree apply disabled/);
    assert.match(result.stdout, /Observed first accepted tasks: 0/);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unfinished work');
    assert.equal(git(s.root, 'rev-parse', 'HEAD'), head);
    assert.deepEqual(fs.readFileSync(path.join(s.gitDir, 'index')), index);
    const store = new Store(s.state, { readOnly: true });
    try { assert.equal(store.list('scan').length, 1); assert.equal(store.list('action').length, 0); }
    finally { store.close(); }
  }
  assert.ok(fs.existsSync(`${config}.scan-report.lock`));
});

test('Windows runner passes argument arrays, one completed UTC week and large inherited output', { skip: !windows, timeout: 30000 }, async t => {
  const s = scripted(t, `process.stdout.write('x'.repeat(1024 * 1024));`);
  const before = new Date();
  const result = await launch(s.script, s.config).done;
  const after = new Date();
  assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout.length, 2 * 1024 * 1024);
  const calls = s.calls(); assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['scan', '--config', s.config]);
  const [command, flag, config, fromFlag, from, toFlag, to] = calls[1];
  assert.deepEqual([command, flag, config, fromFlag, toFlag], ['report', '--config', s.config, '--from', '--to']);
  assert.ok([before, after].some(date => date.toISOString().slice(0, 10) === to));
  assert.equal(Date.parse(to) - Date.parse(from), 7 * 86400000);
});

test('Windows runner short-circuits failed scan and releases its handle after command or launch failure', { skip: !windows, timeout: 45000 }, async t => {
  const s = scripted(t, `process.exit(7);`);
  for (let i = 0; i < 2; i++) {
    const result = await launch(s.script, s.config).done;
    assert.equal(result.code, 1); assert.match(result.stderr, /failed with exit 7/);
  }
  assert.deepEqual(s.calls().map(args => args[0]), ['scan', 'scan']);
  const invalid = path.join(s.root, 'not-executable.exe'); fs.writeFileSync(invalid, 'invalid executable');
  assert.equal((await launch(s.script, s.config, 20, invalid).done).code, 1);
  const next = await launch(s.script, s.config).done;
  assert.match(next.stderr, /failed with exit 7/);
  const r = scripted(t, `if (args[0] === 'report') process.exit(9);`);
  const result = await launch(r.script, r.config).done;
  assert.equal(result.code, 1); assert.match(result.stderr, /failed with exit 9/);
  assert.deepEqual(r.calls().map(args => args[0]), ['scan', 'report']);
});

test('Windows runners sharing the config lock cannot overlap and normal release permits a fresh cycle', { skip: !windows, timeout: 45000 }, async t => {
  const s = scripted(t, `if (args[0] === 'scan') { fs.writeFileSync(path.join(root, 'started'), ''); while (!fs.existsSync(path.join(root, 'release'))) await new Promise(resolve => setTimeout(resolve, 10)); }`);
  const first = launch(s.script, s.config, 30);
  try {
    await waitFor(path.join(s.root, 'started'), first.child);
    const second = await launch(s.script, s.config).done;
    assert.equal(second.code, 1); assert.equal(s.calls().length, 1);
  } finally { fs.writeFileSync(path.join(s.root, 'release'), ''); await first.done; }
  assert.equal((await first.done).code, 0);
  assert.equal((await launch(s.script, s.config).done).code, 0);
  assert.deepEqual(s.calls().map(args => args[0]), ['scan', 'report', 'scan', 'report']);
});

test('Windows timeout requests termination of ordinary children, releases lock and shares budget between scan/report', { skip: !windows, timeout: 45000 }, async t => {
  const s = scripted(t, `if (!fs.existsSync(path.join(root, 'release'))) {
    const child = spawn(process.execPath, ['-e', "setTimeout(() => require('fs').writeFileSync(process.argv[1], 'escaped'), 15000)", path.join(root, 'descendant')], { windowsHide: true, stdio: 'ignore' });
    fs.writeFileSync(path.join(root, 'started'), String(child.pid));
    setTimeout(() => fs.writeFileSync(path.join(root, 'direct'), 'escaped'), 15000);
  }`);
  const running = launch(s.script, s.config, 4);
  await waitFor(path.join(s.root, 'started'), running.child);
  const result = await running.done;
  assert.equal(result.code, 1); assert.match(result.stderr, /wait budget exhausted/);
  const pid = Number(fs.readFileSync(path.join(s.root, 'started'), 'utf8'));
  const until = Date.now() + 5000;
  while (true) {
    try { process.kill(pid, 0); }
    catch (error) { assert.equal(error.code, 'ESRCH'); break; }
    assert.ok(Date.now() < until, 'ordinary descendant survived timeout fixture');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(!fs.existsSync(path.join(s.root, 'direct'))); assert.ok(!fs.existsSync(path.join(s.root, 'descendant')));
  fs.writeFileSync(path.join(s.root, 'release'), '');
  assert.equal((await launch(s.script, s.config).done).code, 0);
  const shared = scripted(t, `if (args[0] === 'scan') await new Promise(resolve => setTimeout(resolve, 2500)); else await new Promise(resolve => setTimeout(resolve, 2500));`);
  const budget = await launch(shared.script, shared.config, 4).done;
  assert.equal(budget.code, 1); assert.match(budget.stderr, /wait budget exhausted/);
  assert.deepEqual(shared.calls().map(args => args[0]), ['scan', 'report']);
});
