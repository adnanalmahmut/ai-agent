#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopDecision } from './policy.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

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

function run(command, args) {
  return spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const input = await readInput();
const harness = process.argv[2] ?? 'codex';
const failures = [];
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

process.stdout.write(`${JSON.stringify(stopDecision(harness, failures, input))}\n`);
