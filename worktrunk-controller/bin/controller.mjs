#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../lib/config.mjs';
import { Store } from '../lib/store.mjs';
import { invocation } from '../lib/invoke.mjs';
import { enroll } from '../lib/identity.mjs';
import { scanProject } from '../lib/observe.mjs';
import { localPath } from '../lib/paths.mjs';

try {
  const { values, positionals } = parseArgs({ options: { config: { type: 'string' }, project: { type: 'string' }, path: { type: 'string' }, format: { type: 'string', default: 'text' } }, allowPositionals: true });
  const [command, ...extra] = positionals;
  if (extra.length || !['scan', 'enroll'].includes(command) || !values.config || !['json', 'text'].includes(values.format)) throw new Error('Usage: node worktrunk-controller/bin/controller.mjs scan|enroll --config <absolute-file> [--project <id>] [--path <absolute-worktree>] [--format json|text]');
  if ((command === 'enroll') !== Boolean(values.path) || (command === 'enroll' && !values.project)) throw new Error('Enrollment requires --project and --path; scan does not accept --path');
  const config = loadConfig(localPath(values.config));
  const projects = config.projects.filter(project => !values.project || values.project === project.id);
  if (!projects.length) throw new Error('No matching registered project');
  const store = new Store(config.stateDir);
  try {
    let output;
    if (command === 'enroll') {
      const project = projects[0];
      output = invocation(config, project.root, ({ git }) => {
        const root = localPath(values.path);
        const common = localPath(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], root).trim());
        const expected = localPath(git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
        if (common !== expected) throw new Error('Worktree is outside the selected repository');
        const top = localPath(git(['rev-parse', '--show-toplevel'], root).trim());
        if (top !== root) throw new Error('Enrollment requires the exact worktree root');
        return enroll(store, root, git(['rev-parse', '--absolute-git-dir'], root).trim());
      });
    } else {
      output = { version: 1, applyEnabled: false, projects: projects.map(project => {
        try { return scanProject(config, store, project); }
        catch (error) { process.exitCode = 1; return { version: 1, project: project.id, status: 'analysis_failed', error: error.message, decisions: [] }; }
      }) };
      if (output.projects.some(project => project.decisions.some(decision => decision.status === 'analysis_failed'))) process.exitCode = 1;
      store.transaction(tx => {
        for (const project of output.projects) {
          tx.put('scan', project.project, project);
          for (const decision of project.decisions) tx.put('decision', decision.id, { version: 1, ...decision, policyGeneration: config.generation });
        }
      });
    }
    if (values.format === 'json') process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    else if (command === 'enroll') process.stdout.write(`Enrolled ${output.path} (${output.id})\n`);
    else for (const project of output.projects) {
      process.stdout.write(`${project.project}: ${project.status ?? `${project.decisions.length} worktrees`}; apply disabled\n`);
      if (project.error) process.stdout.write(`  ${project.error}\n`);
      for (const decision of project.decisions) process.stdout.write(`  ${decision.status} ${path.normalize(decision.path)}: ${decision.reasons.join(', ')}${decision.error ? ` (${decision.error})` : ''}\n`);
    }
  } finally { store.close(); }
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
