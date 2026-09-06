import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { extractCommand, findViolation, preToolDecision, stopDecision } from '../policy.mjs';
import { repositoryRoot, runCompletionChecks } from '../stop-check.mjs';

const testRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const denied = [
  ['git push --force origin feature', 'git-force-push'],
  ['git push origin main', 'git-direct-main-push'],
  ['git push --set-upstream origin HEAD:main', 'git-direct-main-push'],
  ['git reset --hard HEAD~1', 'git-destructive-reset'],
  ['git -C worktree clean -fd', 'git-destructive-reset'],
  ['rm -rf build/cache', 'recursive-delete'],
  ['sudo rm --recursive --force build/cache', 'recursive-delete'],
  ['docker compose down -v', 'docker-volume-delete'],
  ['docker compose -f compose.yml down --volumes', 'docker-volume-delete'],
  ['gh pr merge 42 --squash', 'github-merge'],
  ['gh workflow run deploy-production.yml', 'production-workflow'],
  ['cat /etc/ai-agent/runtime.env', 'runtime-env'],
  ["sudo sed -n '1,20p' /etc/ai-agent/runtime.env", 'runtime-env'],
  ['sudo nano /etc/ai-agent/runtime.env', 'runtime-env'],
  ['ssh deploy@example.test', 'manual-remote-access'],
];

test('classifies high-confidence forbidden commands', () => {
  for (const [command, id] of denied) assert.equal(findViolation(command)?.id, id, command);
});

test('allows ordinary repository-local commands and runtime path text searches', () => {
  for (const command of [
    'git status --short',
    'pnpm typecheck',
    'docker compose config',
    'gh pr view 42',
    "rg '/etc/ai-agent/runtime.env' docs .agents",
    "git grep '/etc/ai-agent/runtime.env'",
  ]) {
    assert.equal(findViolation(command), null, command);
  }
});

test('extracts common tool input envelopes', () => {
  assert.equal(extractCommand({ tool_input: { command: 'git status' } }), 'git status');
  assert.equal(extractCommand({ input: { cmd: 'pnpm test' } }), 'pnpm test');
  assert.equal(extractCommand({ command: 'node --check file.mjs' }), 'node --check file.mjs');
});

test('formats deny decisions for every harness', () => {
  const violation = findViolation('git push origin main');
  assert.equal(preToolDecision('cursor', violation).permission, 'deny');
  assert.equal(preToolDecision('claude', violation).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(preToolDecision('codex', violation).hookSpecificOutput.hookEventName, 'PreToolUse');
});

test('formats documented Codex Stop responses', () => {
  assert.deepEqual(stopDecision('codex', ['check'], {}), {
    decision: 'block',
    reason: 'Repository completion checks failed: check',
  });
  assert.deepEqual(stopDecision('codex', [], {}), {});
  assert.deepEqual(stopDecision('codex', ['check'], { stop_hook_active: true }), {});
});

test('formats documented Claude and Cursor Stop responses', () => {
  assert.deepEqual(stopDecision('claude', ['check'], {}), {
    decision: 'block',
    reason: 'Repository completion checks failed: check',
  });
  assert.deepEqual(stopDecision('claude', ['check'], { stop_hook_active: true }), {});

  const cursor = stopDecision('cursor', ['check'], {});
  assert.equal(cursor.followup_message.includes('at most two retries'), true);
  assert.deepEqual(stopDecision('cursor', ['check'], { loop_count: 2 }), {});
});

test('runs identical completion checks from root and nested working directories', { concurrency: false }, () => {
  assert.equal(repositoryRoot, testRoot);
  const originalCwd = process.cwd();

  try {
    for (const cwd of ['', 'apps/control-plane', 'apps/web']) {
      process.chdir(resolve(testRoot, cwd));
      const calls = [];
      const failures = runCompletionChecks((command, args, options) => {
        calls.push({ command, args, cwd: options.cwd });
        return { status: 0, stdout: '', stderr: '' };
      });

      assert.deepEqual(failures, [], cwd || '.');
      assert.deepEqual(calls, [
        { command: 'git', args: ['diff', '--check'], cwd: testRoot },
        {
          command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
          args: ['agents:check'],
          cwd: testRoot,
        },
      ], cwd || '.');
    }
  } finally {
    process.chdir(originalCwd);
  }
});
