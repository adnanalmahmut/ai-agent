#!/usr/bin/env node
import { extractCommand, findViolation, preToolDecision } from './policy.mjs';

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

const harness = process.argv[2] ?? 'codex';
const input = await readInput();
const decision = preToolDecision(harness, findViolation(extractCommand(input)));
process.stdout.write(`${JSON.stringify(decision)}\n`);
