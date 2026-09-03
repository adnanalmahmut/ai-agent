import { describe, expect, it } from '@jest/globals';

import {
  AgentOutputContractError,
  isAgentOutputContractError,
} from '../../../ai/execution/agent-output-contract.error';
import {
  AGENT_OUTPUT_CONTRACT_VIOLATIONS,
  type AgentOutputContractViolation,
  type AgentOutputContractViolationCode,
} from '../../../ai/agents/agent.types';

/**
 * The violation vocabulary, and the one property that makes listing it worth
 * anything.
 *
 * `AGENT_OUTPUT_CONTRACT_VIOLATIONS` is a tuple beside a discriminated union,
 * and a tuple nothing reads is decoration: adding a member to the union without
 * adding it to the tuple, or the reverse, would be invisible. So the agreement
 * is asserted in both directions — at the type level, and by building an error
 * for every declared code and requiring it to be named.
 */

/** `true` only when the two types are mutually assignable. */
type AssertEqual<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;

/**
 * A compile error here means the union and the tuple have drifted. It is the
 * whole reason the tuple exists, and it costs one unused binding.
 */
const CODES_AGREE: AssertEqual<
  AgentOutputContractViolation['code'],
  AgentOutputContractViolationCode
> = true;

/**
 * One violation per declared code, built through a `switch` with no default.
 *
 * The exhaustiveness is the point: a code added to the vocabulary without a
 * case here fails to compile, so the loop below cannot silently stop covering
 * it. Every value is an integer or a literal — the same containment rule the
 * violation type enforces.
 */
function violationFor(
  code: AgentOutputContractViolationCode,
): AgentOutputContractViolation {
  switch (code) {
    case 'count_mismatch':
      return { code, expected: 5, received: 4 };
    case 'unverifiable':
      return { code };
  }
}

describe('AgentOutputContractError', () => {
  it('keeps its declared vocabulary and its union in step', () => {
    expect(CODES_AGREE).toBe(true);
    expect([...AGENT_OUTPUT_CONTRACT_VIOLATIONS].sort()).toEqual([
      'count_mismatch',
      'unverifiable',
    ]);
  });

  /**
   * Every code produces a message that names it. A code the message builder had
   * never heard of would otherwise fall through to something generic, and the
   * log line an operator reads is the only place this failure is visible.
   */
  it.each([...AGENT_OUTPUT_CONTRACT_VIOLATIONS])(
    'names %s in its message',
    (code) => {
      const error = new AgentOutputContractError(violationFor(code));

      expect(error.message).toBe(
        code === 'count_mismatch'
          ? 'Agent output does not satisfy its declared contract: count_mismatch (expected 5, received 4)'
          : `Agent output does not satisfy its declared contract: ${code}`,
      );
      expect(error.violation).toEqual(violationFor(code));
    },
  );

  /**
   * Identity, not the name, is what the worker branches on — so the name has to
   * survive being carried out of the process, and a forged one must not be
   * recognised.
   */
  it('is recognised by class and not by name', () => {
    const real = new AgentOutputContractError({ code: 'unverifiable' });

    expect(isAgentOutputContractError(real)).toBe(true);
    expect(real.name).toBe('AgentOutputContractError');

    /**
     * BullMQ serializes an error with `Object.getOwnPropertyNames`, so a `name`
     * left on the prototype disappears across a process boundary.
     */
    expect(Object.getOwnPropertyNames(real)).toContain('name');

    // A provider that chose this name is still not one of ours.
    const forged = new Error('anything');
    forged.name = 'AgentOutputContractError';

    expect(isAgentOutputContractError(forged)).toBe(false);
  });
});
