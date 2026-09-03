import { createHash } from 'node:crypto';

import type { AgentValue } from '../agents/agent.types';

export function digestValue(value: AgentValue): string {
  return createHash('sha256')
    .update(JSON.stringify(sortValue(value)))
    .digest('hex');
}

export function digestStrings(parts: readonly string[]): string {
  return digestValue([...parts]);
}

function sortValue(value: AgentValue): AgentValue {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortValue(nested)]),
  );
}
