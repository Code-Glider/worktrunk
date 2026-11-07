import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { integer, object } from './data.mjs';

const exec = promisify(execFile);

export async function githubGet(endpoint, { paginate, timeout }) {
  const args = ['api', '--hostname', 'github.com', '--method', 'GET', endpoint];
  if (paginate) args.push('--paginate', '--slurp');
  let stdout;
  try {
    ({ stdout } = await exec('gh', args, { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('GitHub issue sync requires the GitHub CLI (gh)');
    throw new Error('GitHub issue read failed. Check GitHub CLI access and sync limits.');
  }
  return JSON.parse(stdout);
}

function eventTime(value) {
  const time = Date.parse(value);
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value) || !Number.isSafeInteger(time) || time < 0 || new Date(time).toISOString() !== value.replace(/Z$/, '.000Z')) throw new Error('Invalid GitHub event timestamp');
  return time;
}

export async function fetchIssueEvents(source, issueNumber, timeout, request) {
  const { repository, repositoryId, acceptorIds } = source.github;
  const repoEndpoint = `repos/${repository}`;
  const issueEndpoint = `${repoEndpoint}/issues/${issueNumber}`;
  const repo = object(await request(repoEndpoint, { timeout }), 'GitHub repository');
  if (repo.id !== repositoryId || repo.full_name?.toLowerCase() !== repository) throw new Error('GitHub repository identity changed');
  const issue = object(await request(issueEndpoint, { timeout }), 'GitHub issue');
  if (Object.hasOwn(issue, 'pull_request') || issue.number !== issueNumber || issue.repository_url?.toLowerCase() !== `https://api.github.com/${repoEndpoint}`) throw new Error('Selected GitHub issue does not match the configured repository and issue number');
  const taskId = String(integer(issue.id, 'GitHub issue ID', 1));
  const authorityProject = String(repositoryId);
  const base = { version: 1, taskId, authorityProject, project: source.projects[0] };
  const pages = await request(`${issueEndpoint}/timeline?per_page=100`, { paginate: true, timeout });
  if (!Array.isArray(pages) || !pages.length || !pages.every(Array.isArray)) throw new Error('Invalid GitHub issue timeline');
  const events = [];
  for (const page of pages) for (const item of page) {
    const row = object(item, 'GitHub timeline event');
    if (row.event === 'reopened') {
      events.push({ ...base, eventId: `reopen:${integer(row.id, 'GitHub reopen ID', 1)}`, type: 'task_reopened', at: eventTime(row.created_at) });
    } else if (row.event === 'commented' && row.user?.type === 'User' && acceptorIds.includes(row.user.id) && row.created_at === row.updated_at && typeof row.body === 'string') {
      const match = /^\/worktrunk accept ([1-9]\d*) ([\da-f]{40})$/i.exec(row.body);
      if (!match || match[0] !== row.body) continue;
      const attemptNumber = integer(Number(match[1]), 'GitHub acceptance attempt number', 1);
      events.push({ ...base, eventId: `comment:${integer(row.id, 'GitHub comment ID', 1)}`, type: 'attempt_accepted', at: eventTime(row.created_at), attemptId: String(attemptNumber), attemptNumber, head: match[2].toLowerCase() });
    }
  }
  return { taskId, authorityProject, events };
}
