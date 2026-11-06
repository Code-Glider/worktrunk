import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { Store } from '../lib/store.mjs';
import { enroll, inspectIdentity, recordRelocation } from '../lib/identity.mjs';
import { child, git, repository } from './helpers.mjs';

function setup(t) {
  const repo = repository(t);
  const store = new Store(repo.state);
  // The repository fixture's cleanup is first, so explicitly close before it.
  const close = () => { if (store.db.isOpen) store.close(); };
  return { ...repo, store, close };
}

test('observation never enrolls and explicit enrollment binds native identity', t => {
  const { root, gitDir, store, close } = setup(t);
  try {
    assert.equal(inspectIdentity(store, root, gitDir), null);
    assert.equal(fs.existsSync(path.join(gitDir, 'worktrunk-controller-worktree.json')), false);
    const value = enroll(store, root, gitDir);
    assert.equal(inspectIdentity(store, root, gitDir).value.id, value.id);
    assert.throws(() => enroll(store, root, gitDir), /Already enrolled/);
  } finally { close(); }
});

test('copied enrollment marker cannot adopt another checkout', t => {
  const { base, root, gitDir, store, close } = setup(t);
  try {
    enroll(store, root, gitDir);
    const other = path.join(base, 'other'); git(root, 'worktree', 'add', '-b', 'other', other);
    const otherGit = git(other, 'rev-parse', '--absolute-git-dir');
    fs.copyFileSync(path.join(gitDir, 'worktrunk-controller-worktree.json'), path.join(otherGit, 'worktrunk-controller-worktree.json'));
    assert.equal(inspectIdentity(store, other, otherGit), null);
    assert.throws(() => enroll(store, other, otherGit), /Conflicting enrollment marker/);
  } finally { close(); }
});

test('same-path same-HEAD registration recreation invalidates old enrollment', t => {
  const { base, root, store, close } = setup(t);
  try {
    const checkout = path.join(base, 'child'); git(root, 'worktree', 'add', '-b', 'child', checkout);
    const admin = git(checkout, 'rev-parse', '--absolute-git-dir');
    const beforeHead = git(checkout, 'rev-parse', 'HEAD');
    const old = enroll(store, checkout, admin);
    const markerContents = fs.readFileSync(path.join(admin, 'worktrunk-controller-worktree.json'));
    git(root, 'worktree', 'remove', checkout);
    git(root, 'worktree', 'add', checkout, 'child');
    const newAdmin = git(checkout, 'rev-parse', '--absolute-git-dir');
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), beforeHead);
    assert.equal(newAdmin, admin);
    assert.equal(inspectIdentity(store, checkout, newAdmin), null);
    fs.writeFileSync(path.join(newAdmin, 'worktrunk-controller-worktree.json'), markerContents);
    assert.equal(inspectIdentity(store, checkout, newAdmin), null, 'copying the old marker cannot restore native evidence');
    assert.equal(store.get('identity', old.id).value.id, old.id);
    assert.throws(() => enroll(store, checkout, newAdmin), /incarnation changed/);
  } finally { close(); }
});

test('verified Git worktree move preserves identity after explicit relocation', t => {
  const { base, root, store, close } = setup(t);
  try {
    const from = path.join(base, 'child'); const to = path.join(base, 'ילד moved');
    git(root, 'worktree', 'add', '-b', 'child', from);
    const admin = git(from, 'rev-parse', '--absolute-git-dir');
    const value = enroll(store, from, admin);
    git(root, 'worktree', 'move', from, to);
    assert.equal(inspectIdentity(store, to, admin), null, 'observation cannot authorize a move');
    recordRelocation(store, value.id, to, admin);
    assert.equal(inspectIdentity(store, to, admin).value.id, value.id);
  } finally { close(); }
});

test('killed enrollment remains unmanaged until an explicit matching retry', async t => {
  const { root, gitDir, state, store, close } = setup(t);
  try {
    const run = child('enroll-interrupt', state, root, gitDir);
    await Promise.race([once(run.process.stdout, 'data'), run.done.then(result => { throw new Error(result.stderr); })]);
    run.process.kill('SIGKILL'); await run.done;
    assert.equal(inspectIdentity(store, root, gitDir), null);
    assert.equal(store.list('identity').length, 0);
    assert.equal(store.list('enrollment')[0].value.state, 'pending');
    const value = enroll(store, root, gitDir);
    assert.equal(inspectIdentity(store, root, gitDir).value.id, value.id);
  } finally { close(); }
});
