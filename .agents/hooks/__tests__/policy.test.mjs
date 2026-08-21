import assert from 'node:assert/strict';
import test from 'node:test';
import { extractCommand, findViolation, preToolDecision, stopDecision } from '../policy.mjs';

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
  ['sed -n 1,20p /etc/ai-agent/runtime.env', 'runtime-env'],
  ['ssh deploy@example.test', 'manual-remote-access'],
];

test('classifies high-confidence forbidden commands', () => {
  for (const [command, id] of denied) assert.equal(findViolation(command)?.id, id, command);
});

test('allows ordinary repository-local commands', () => {
  for (const command of ['git status --short', 'pnpm typecheck', 'docker compose config', 'gh pr view 42']) {
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

test('bounds completion repair loops', () => {
  assert.equal(stopDecision('cursor', ['check'], {}).followup_message.includes('at most two retries'), true);
  assert.equal(stopDecision('claude', ['check'], {}).decision, 'block');
  assert.equal(stopDecision('codex', ['check'], { stop_hook_active: true }).systemMessage.includes('limit is reached'), true);
  assert.deepEqual(stopDecision('codex', [], {}), {});
});
