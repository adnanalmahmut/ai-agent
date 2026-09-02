import type { AgentOutputContractViolation } from '../agents/agent.types';

/**
 * A provider answer that parsed and still failed the promise made about it.
 *
 * ## Why a class rather than a plain `Error`
 *
 * Not to change how it is retried. This is emphatically *not* an
 * `AgentConfigurationError`: a model that returned four ideas for a request of
 * five may return five on the next attempt, so the failure keeps its full
 * budget exactly as a malformed answer does, and the worker's `deterministic`
 * branch must not see it.
 *
 * It exists so the failure can be *named*. Every attempt writes the same
 * constant to `AgentRun.lastError` and rethrows the same constant to BullMQ, by
 * design — so without a class, a model that has started miscounting is
 * indistinguishable in the log from a provider outage, a timeout, and a schema
 * mismatch. Those are four problems with four different remedies, and the one
 * an operator can actually act on is this one: a contract violation burns the
 * whole attempt budget in paid provider calls and holds an in-flight slot while
 * it does, so it presents as a spend multiplier rather than as an error rate.
 * The handler reads this class for one purpose only: to pick the word it logs.
 *
 * ## What it may carry
 *
 * The violation, which is a closed code and — for a count mismatch — two
 * integers. Nothing else, and in particular nothing derived from the provider's
 * answer: the message is composed here from those application-owned values, so
 * a contract cannot smuggle model output into an `Error` even by accident,
 * because `AgentOutputContractViolation` carries no string at all.
 */
export class AgentOutputContractError extends Error {
  readonly violation: AgentOutputContractViolation;

  constructor(violation: AgentOutputContractViolation) {
    super(
      `Agent output does not satisfy its declared contract: ${detail(violation)}`,
    );

    this.violation = violation;

    /**
     * Assigned as an own property, not left on the prototype. BullMQ serializes
     * an error across a process boundary with `Object.getOwnPropertyNames`, so a
     * name that lives only on the prototype silently disappears.
     */
    this.name = 'AgentOutputContractError';

    // Restores the prototype chain, so `instanceof` holds regardless of the
    // TypeScript target the file is compiled under.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The message, from the violation's own closed vocabulary and integers. */
function detail(violation: AgentOutputContractViolation): string {
  if (violation.code === 'count_mismatch') {
    return `count_mismatch (expected ${violation.expected}, received ${violation.received})`;
  }

  return violation.code;
}

/**
 * Whether a caught value is one of ours.
 *
 * `instanceof` and nothing else, for the same reason
 * `isAgentConfigurationError` is: only code in this repository can construct
 * the class, so identity is the one signal a failing provider cannot forge by
 * choosing an error name.
 */
export function isAgentOutputContractError(
  error: unknown,
): error is AgentOutputContractError {
  return error instanceof AgentOutputContractError;
}
