import { describe, expect, it } from '@jest/globals';

import {
  AgentOutputContractError,
  isAgentOutputContractError,
} from '../../../../src/ai/execution/agent-output-contract.error';
import {
  AGENT_OUTPUT_CONTRACT_VIOLATIONS,
  type AgentOutputContractViolation,
  type AgentOutputContractViolationCode,
} from '../../../../src/ai/agents/agent.types';

type AssertEqual<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;

const CODES_AGREE: AssertEqual<
  AgentOutputContractViolation['code'],
  AgentOutputContractViolationCode
> = true;

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

  it('is recognised by class and not by name', () => {
    const real = new AgentOutputContractError({ code: 'unverifiable' });

    expect(isAgentOutputContractError(real)).toBe(true);
    expect(real.name).toBe('AgentOutputContractError');

    expect(Object.getOwnPropertyNames(real)).toContain('name');

    const forged = new Error('anything');
    forged.name = 'AgentOutputContractError';

    expect(isAgentOutputContractError(forged)).toBe(false);
  });
});
