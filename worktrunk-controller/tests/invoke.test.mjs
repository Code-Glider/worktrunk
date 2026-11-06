import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolatedEnvironment, invocation, worktreeInventory, refVector } from '../lib/invoke.mjs';
import { fixture, repository } from './helpers.mjs';

test('invocation environment removes inherited Git and Worktrunk overrides/directives', t => {
  const scratch = fixture(t);
  const env = isolatedEnvironment(scratch, { PATH: process.env.PATH, GIT_DIR: 'wrong', GIT_CONFIG_COUNT: '1', GIT_TRACE: 'secret-file', WORKTRUNK_DIRECTIVE_CD_FILE: 'host-file', WORKTRUNK_VERBOSE: '2', WORKTRUNK__LIST__FULL: 'true', RUST_LOG: 'trace' });
  for (const key of ['GIT_DIR', 'GIT_CONFIG_COUNT', 'GIT_TRACE', 'WORKTRUNK_DIRECTIVE_CD_FILE', 'WORKTRUNK_VERBOSE', 'WORKTRUNK__LIST__FULL', 'RUST_LOG']) assert.equal(env[key], undefined);
  assert.equal(env.GIT_NO_LAZY_FETCH, '1');
  assert.equal(env.WORKTRUNK_PROJECT_CONFIG_PATH, '');
  assert.equal(env.GIT_ALLOW_PROTOCOL, '');
});

test('Git inventory and refs use explicit cwd; successful scratch alone is removed', t => {
  const repo = repository(t);
  const config = { stateDir: repo.state, limits: { timeoutMs: 5000 } };
  const result = invocation(config, repo.root, ({ git, scratch }) => {
    const inventory = worktreeInventory(git);
    assert.equal(inventory.length, 1);
    assert.equal(inventory[0].branch, 'refs/heads/main');
    assert.match(refVector(git)['refs/heads/main'], /^[a-f0-9]{40}$/);
    return scratch;
  });
  assert.equal(fs.existsSync(result), false);
  assert.equal(fs.readdirSync(path.join(repo.state, 'invocations')).length, 0);
});

test('caught probe failure still retains its own scratch', t => {
  const repo = repository(t);
  const scratch = invocation({ stateDir: repo.state, limits: { timeoutMs: 5000 } }, repo.root, ({ git, scratch }) => {
    assert.throws(() => git(['rev-parse', '--verify', 'nonexistent']));
    return scratch;
  });
  assert.ok(fs.existsSync(scratch));
});
