#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

function run(command, args, fallback = '') {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return fallback;
  }
}

const root = run('git', ['rev-parse', '--show-toplevel']);
if (!root) {
  console.error('agents:resume must be run inside a Git repository');
  process.exit(2);
}

process.chdir(root);
const todoPath = process.env.AGENTS_TODO ?? 'TODO.md';

if (!existsSync(todoPath)) {
  console.error(
    `${todoPath} is missing. Restore the local dashboard from the tracked exec plan before continuing.`,
  );
  process.exit(2);
}

const todo = readFileSync(todoPath, 'utf8');

const activeMatch = todo.match(
  /# ACTIVE PR\n([\s\S]*?)(?=\n---\n\n# |\n# APPROVED EXECUTION WINDOW|$)/,
);

const activeSection = activeMatch?.[1] ?? '';

const activeHeading =
  activeSection.match(/^##\s+(.+)$/m)?.[1] ??
  'No ACTIVE PR heading found';

const nextUnchecked =
  activeSection
    .split('\n')
    .find((line) => /^\s*- \[ \]/.test(line))
    ?.replace(/^\s*- \[ \]\s*/, '') ??
  'No unchecked item found under ACTIVE PR';

const branch = run(
  'git',
  ['branch', '--show-current'],
  '(detached)',
);

const head = run(
  'git',
  ['rev-parse', 'HEAD'],
  'unknown',
);

const status = run(
  'git',
  ['status', '--short', '--branch'],
  '(status unavailable)',
);

const log = run(
  'git',
  ['log', '--oneline', '--decorate', '-n', '10'],
  '(log unavailable)',
);

const diff = run(
  'git',
  ['diff', '--stat'],
  '(no unstaged diff)',
);

const cached = run(
  'git',
  ['diff', '--cached', '--stat'],
  '(no staged diff)',
);

const ignored =
  run('git', ['check-ignore', todoPath], '') === todoPath;

let prState =
  '(gh unavailable, unauthenticated, or no PR for this branch)';

if (
  branch &&
  branch !== '(detached)' &&
  branch !== 'main'
) {
  const result = run('gh', [
    'pr',
    'list',
    '--head',
    branch,
    '--state',
    'all',
    '--limit',
    '5',
    '--json',
    'number,title,state,isDraft,baseRefName,headRefName,url,mergeStateStatus,statusCheckRollup',
  ]);

  if (result) {
    prState = result;
  }
}

console.log(`\n=== AGENT RESUME SNAPSHOT ===`);
console.log(`Repository: ${root}`);
console.log(
  `TODO: ${todoPath} (${ignored ? 'gitignored' : 'WARNING: not ignored'})`,
);
console.log(`Active: ${activeHeading}`);
console.log(`Next unchecked: ${nextUnchecked}`);
console.log(`Branch: ${branch}`);
console.log(`HEAD: ${head}`);

console.log(`\n--- git status ---\n${status}`);

console.log(`\n--- recent history ---\n${log}`);

console.log(
  `\n--- unstaged diff stat ---\n${diff || '(clean)'}`,
);

console.log(
  `\n--- staged diff stat ---\n${cached || '(none)'}`,
);

console.log(
  `\n--- GitHub PR state ---\n${prState}`,
);

console.log(`\n=== REQUIRED TAKEOVER BEHAVIOR ===`);

console.log(
  `1. Treat Git/GitHub and tracked plans as authority over TODO.md.`,
);

console.log(
  `2. Preserve and inspect inherited work before editing.`,
);

console.log(
  `3. Reconcile TODO.md, then continue the first legitimate unchecked item under ACTIVE PR.`,
);

console.log(
  `4. Do not reset, stash, force-push, merge, or start an unapproved ROADMAP PR.`,
);

console.log(
  `5. Update TODO.md after each objectively verified step and before compacting/stopping.`,
);

console.log(`\nReady prompt:`);

console.log(
  `Run \`pnpm agents:resume\`, reconcile TODO.md against the actual Git/GitHub state, preserve inherited work, and continue the first legitimate unchecked item under \`# ACTIVE PR\`. Do not start an unapproved ROADMAP PR, reset/stash/force-push, or merge. Update TODO.md after every verified step and stop only at the current PR handoff condition.`,
);