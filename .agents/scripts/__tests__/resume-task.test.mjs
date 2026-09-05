import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = resolve(dirname(fileURLToPath(import.meta.url)), '../resume-task.mjs');

/**
 * A throwaway repository, so the assertions describe the script rather than
 * whatever this working tree happens to look like today.
 */
function makeRepository() {
  const directory = mkdtempSync(join(tmpdir(), 'agents-resume-'));
  const git = (...args) => execFileSync('git', args, { cwd: directory, stdio: 'ignore' });
  git('init', '--initial-branch', 'main');
  git('config', 'user.email', 'test@example.test');
  git('config', 'user.name', 'Test');
  writeFileSync(join(directory, 'file.txt'), 'one\n');
  git('add', 'file.txt');
  git('commit', '-m', 'initial');
  git('switch', '-c', 'feature/resume-fixture');
  return directory;
}

/**
 * `gh` is stubbed as failing so the unavailable path is exercised identically on
 * a developer machine with an authenticated CLI and on CI without one. It lives
 * outside the inspected repository, which would otherwise see it as new work.
 */
const stubbedPath = (() => {
  const bin = mkdtempSync(join(tmpdir(), 'agents-resume-bin-'));
  const stub = join(bin, 'gh');
  writeFileSync(stub, '#!/bin/sh\nexit 1\n');
  chmodSync(stub, 0o755);
  return `${bin}:${process.env.PATH}`;
})();

function resume(directory, env = {}) {
  const result = spawnSync(process.execPath, [script], {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, PATH: stubbedPath, ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function snapshot(directory) {
  return execFileSync('git', ['status', '--porcelain', '-z'], { cwd: directory, encoding: 'utf8' })
    + execFileSync('git', ['rev-parse', 'HEAD', 'feature/resume-fixture'], { cwd: directory, encoding: 'utf8' });
}

const posixOnly = { skip: process.platform === 'win32' ? 'POSIX stub shell script' : false };

test('reports branch, HEAD, and status with no dashboard present', posixOnly, () => {
  const directory = makeRepository();
  try {
    const output = resume(directory);
    assert.match(output, /Branch:\s+feature\/resume-fixture/);
    assert.match(output, /HEAD:\s+[0-9a-f]{40}/);
    assert.match(output, /--- git status ---/);
    assert.match(output, /--- recent history ---/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('reports a dirty working tree without touching it', posixOnly, () => {
  const directory = makeRepository();
  try {
    writeFileSync(join(directory, 'file.txt'), 'two\n');
    writeFileSync(join(directory, 'untracked.txt'), 'inherited\n');
    const before = snapshot(directory);
    const output = resume(directory);
    assert.match(output, /file\.txt/);
    assert.match(output, /untracked\.txt/);
    assert.equal(snapshot(directory), before, 'resume must not mutate the repository');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('degrades to local evidence when gh cannot answer', posixOnly, () => {
  const directory = makeRepository();
  try {
    const output = resume(directory);
    assert.match(output, /GitHub evidence unavailable/);
    assert.match(output, /Branch:\s+feature\/resume-fixture/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('prints an optional plain note verbatim without parsing it', posixOnly, () => {
  const directory = makeRepository();
  try {
    writeFileSync(join(directory, 'NOTE.md'), 'Next action: finish the retarget\nBlocker: none\n');
    const before = snapshot(directory);
    const output = resume(directory, { AGENTS_NOTE: 'NOTE.md' });
    assert.match(output, /Next action: finish the retarget/);
    assert.match(output, /not authoritative/);
    assert.equal(snapshot(directory), before, 'resume must not mutate the repository');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('fails clearly outside a Git repository', posixOnly, () => {
  const directory = mkdtempSync(join(tmpdir(), 'agents-resume-bare-'));
  try {
    const result = spawnSync(process.execPath, [script], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, PATH: stubbedPath, GIT_CEILING_DIRECTORIES: tmpdir() },
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /must be run inside a Git repository/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
