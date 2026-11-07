import { spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { digest, integer, text } from './data.mjs';
import { fileIdentity, localPath } from './paths.mjs';
import { reserve, transition } from './admission.mjs';
import { producerRoots } from './artifacts.mjs';
import { verifyNativeHost } from './native-host.mjs';
import { loadConfig } from './config.mjs';
import { syncGitHubIssue } from './events.mjs';
import { inspectIdentity } from './identity.mjs';
import { invocation, worktreeInventory } from './invoke.mjs';

export function managedCheckout(config, store, project, root, readHead = false) {
  return invocation(config, project.root, ({ git }) => {
    root = localPath(root);
    const common = localPath(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], root).trim());
    const worktrees = worktreeInventory(git);
    if (common !== localPath(git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()) || localPath(git(['rev-parse', '--show-toplevel'], root).trim()) !== root ||
      !worktrees.some(entry => !entry.prunable && path.relative(root, entry.path) === '' && localPath(entry.path) === root)) throw new Error('Managed run requires an exact registered worktree root');
    const identity = inspectIdentity(store, root, git(['rev-parse', '--absolute-git-dir'], root).trim());
    if (!identity) throw new Error('Managed run requires explicit matching enrollment');
    const checkout = { root, worktreeId: identity.value.id, repositoryIncarnation: fileIdentity(common), common, worktrees };
    if (readHead) checkout.head = git(['rev-parse', '--verify', 'HEAD^{commit}'], root).trim();
    return checkout;
  });
}

export async function runManaged(config, store, { root, projectId, sessionId, program, args, github }, request) {
  if (process.platform !== 'win32' || !config.nativeHost) throw new Error('Qualified native Windows lifetime host required');
  root = localPath(root); program = localPath(program); text(sessionId, 'sessionId');
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Invalid managed command arguments');
  const host = verifyNativeHost(config);
  const project = config.projects?.find(project => project.id === projectId);
  let task;
  if (github) {
    const source = config.eventSources.find(source => source.id === github.source);
    if (!project || !source?.github || source.projects[0] !== projectId) throw new Error('Managed task requires a GitHub source for the selected project');
    const attempt = integer(github.attempt, 'GitHub attempt number', 1);
    const agentId = github.agentId === undefined ? null : text(github.agentId, 'agent ID');
    const checkout = managedCheckout(config, store, project, root);
    const { issue, taskId } = await syncGitHubIssue(config, store, source.id, github.issue, request);
    const authorityProject = String(source.github.repositoryId);
    task = { taskKey: digest([source.authority, authorityProject, taskId]), sourceInstance: source.instance, project: projectId, issue, taskId, authorityProject, attempt, agentId, worktreeId: checkout.worktreeId, repositoryIncarnation: checkout.repositoryIncarnation, producerAdmission: project.producerAdmission ?? null, nativeHost: host };
  }
  const checkTaskCheckout = readHead => {
    if (loadConfig(config.configPath).generation !== config.generation) throw new Error('Managed task configuration changed during launch');
    const checkout = managedCheckout(config, store, project, root, readHead);
    if (checkout.worktreeId !== task.worktreeId || digest(checkout.repositoryIncarnation) !== digest(task.repositoryIncarnation)) throw new Error('Managed task checkout incarnation changed during launch');
    return checkout.head;
  };
  if (task) checkTaskCheckout(false);
  const claim = reserve(store, { roots: producerRoots(config, store, projectId, root), sessionId, owner: config.host.id, task });
  transition(store, claim.token, 'reserved', 'starting');
  let phase = 'starting', result;
  const child = spawn(host.path, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
  child.stdin.on('error', () => {});
  const finished = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  // Attach immediately: an early spawn failure must not become an unhandled rejection.
  finished.catch(() => {});
  try {
    child.stdin.write(`${JSON.stringify({ version: 1, token: claim.token, cwd: root, program, args })}\n`);
    const lines = createInterface({ input: child.stdout });
    for await (const line of lines) {
      if (line.length > 65536) throw new Error('Oversized native host response');
      const message = JSON.parse(line);
      if (message.version !== 1 || message.evidence?.helperPid !== child.pid || message.evidence?.launchToken !== claim.token) throw new Error('Native lifetime response mismatch');
      if (message.type === 'contained' && phase === 'starting' && message.evidence.activeProcesses === null) {
        if (digest(producerRoots(config, store, projectId, root)) !== digest(claim.roots.map(root => root.path)) || claim.roots.some(root => digest(fileIdentity(root.path)) !== digest(root.incarnation))) throw new Error('Managed root incarnation changed before launch');
        if (digest(host) !== digest(verifyNativeHost(config))) throw new Error('Native host executable changed before launch');
        if (task) checkTaskCheckout(false);
        transition(store, claim.token, phase, 'running', message.evidence);
        phase = 'running';
        child.stdin.write(`ack ${claim.token}\n`);
      } else if (message.type === 'ended' && phase === 'running') {
        if (digest(host) !== digest(verifyNativeHost(config))) throw new Error('Native host executable changed during launch');
        transition(store, claim.token, phase, 'ended', message.evidence, task ? checkTaskCheckout(true) : undefined);
        phase = 'ended'; result = { token: claim.token, exitCode: message.exitCode };
      } else throw new Error('Invalid native lifetime protocol transition');
    }
    const exit = await finished;
    if (phase !== 'ended' || exit.code !== 0) throw new Error('Native lifetime completion unavailable');
    return result;
  } catch (error) {
    try { if (phase !== 'ended') transition(store, claim.token, phase, 'unresolved'); }
    finally { child.kill(); await finished.catch(() => {}); }
    throw error;
  } finally { child.stdin.end(); }
}
