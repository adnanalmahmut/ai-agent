import { createHash } from 'node:crypto';

import type { AgentValue } from '../../ai/agents/agent.types';

/**
 * The result that was accepted for one execution attempt.
 *
 * A success is identified by the output as the pinned definition normalised
 * it, not as it arrived: the same answer written two equivalent ways is one
 * answer, and the normalised value is what was actually persisted. A failure
 * is identified by its code alone — a closed vocabulary both sides agreed on,
 * so nothing a reporter chose becomes part of durable state.
 */
export type SettledResult =
  | { readonly kind: 'succeeded'; readonly output: AgentValue }
  | { readonly kind: 'failed'; readonly code: string };

/**
 * A fixed-width name for one accepted result.
 *
 * Stored instead of the result itself so that a replay can be told from a
 * contradiction without keeping a second copy of an output, and without any
 * text the caller supplied ever reaching a column. Canonical because JSON
 * property order is not information: `{a,b}` and `{b,a}` are the same answer
 * and must hash the same.
 */
export function settlementDigestOf(result: SettledResult): string {
  const canonical =
    result.kind === 'failed'
      ? `failed:${result.code}`
      : `succeeded:${canonicalJson(result.output)}`;

  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** JSON with object keys in a fixed order, so equal values have equal text. */
function canonicalJson(value: AgentValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }

  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);

  return `{${entries.join(',')}}`;
}
