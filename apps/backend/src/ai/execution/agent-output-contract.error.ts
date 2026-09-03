import type { AgentOutputContractViolation } from '../agents/agent.types';

export class AgentOutputContractError extends Error {
  readonly violation: AgentOutputContractViolation;

  constructor(violation: AgentOutputContractViolation) {
    super(
      `Agent output does not satisfy its declared contract: ${detail(violation)}`,
    );

    this.violation = violation;

    this.name = 'AgentOutputContractError';

    // Restores the prototype chain, so `instanceof` holds regardless of the
    // TypeScript target the file is compiled under.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function detail(violation: AgentOutputContractViolation): string {
  if (violation.code === 'count_mismatch') {
    return `count_mismatch (expected ${violation.expected}, received ${violation.received})`;
  }

  return violation.code;
}

export function isAgentOutputContractError(
  error: unknown,
): error is AgentOutputContractError {
  return error instanceof AgentOutputContractError;
}
