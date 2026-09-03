import { createHash } from 'node:crypto';

import type { AgentValue } from '../agents/agent.types';

/**
 * A stable digest of application JSON.
 *
 * Keys are sorted recursively before hashing, so two values that are the same
 * JSON document with a different key order digest alike. That is what makes it
 * usable for "is this the proposal that was approved" and "is this the payload
 * the first attempt sent": both questions are about the value, not about the
 * bytes Prisma happened to return.
 *
 * SHA-256 hex, 64 characters. Not a secret and not a capability — it is
 * stored beside the value it digests and only ever compared for equality.
 */
export function digestValue(value: AgentValue): string {
  return createHash('sha256')
    .update(JSON.stringify(sortValue(value)))
    .digest('hex');
}

/** The same digest over a few strings, for a payload that is not JSON. */
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
