#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopDecision } from './policy.mjs';

const scriptPath = fileURLToPath(import.meta.url);
export const repositoryRoot = resolve(dirname(scriptPath), '../..');

async function readInput() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  if (data.trim() === '') return {};
  try {
    return JSON.parse(data);
  } catch {
    return {};
  }
}

export function runCompletionChecks(runner = spawnSync) {
  const failures = [];
  const run = (command, args) => runner(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const whitespace = run('git', ['diff', '--check']);
  if (whitespace.status !== 0) failures.push('git diff --check');

  try {
    const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'));
    if (packageJson.scripts?.['agents:check']) {
      const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
      const check = run(packageManager, ['agents:check']);
      if (check.status !== 0) failures.push('pnpm agents:check');
    }
  } catch {
    // A missing or invalid package file is outside this hook's portable scope.
  }

  return failures;
}

async function main() {
  const input = await readInput();
  const harness = process.argv[2] ?? 'codex';
  process.stdout.write(`${JSON.stringify(stopDecision(harness, runCompletionChecks(), input))}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) await main();
