/**
 * An execution failure that a retry cannot fix.
 *
 * The retry budget exists for conditions that change on their own — a provider
 * rate limit, a timeout, a connection reset. An `AgentRun` pinned to a
 * definition this deployment does not carry, or one whose persisted runtime
 * disagrees with its definition, is not such a condition: the third attempt
 * resolves exactly the same registry as the first, so the only thing the budget
 * buys is a longer delay before somebody is told.
 *
 * Deliberately one class, not a taxonomy. Every case it covers is the same
 * mismatch between a durable run and the code currently deployed, and every one
 * of them gets the same treatment, so distinguishing them in the type system
 * would add vocabulary that nothing branches on.
 *
 * The message is for a developer reading a stack trace, never for durable state
 * or for BullMQ. The handler substitutes a constant before either sees it.
 */
export class AgentConfigurationError extends Error {
  constructor(message: string) {
    super(message);

    /**
     * Assigned as an own property, not left on the prototype. BullMQ serializes
     * an error across a process boundary with `Object.getOwnPropertyNames`, so a
     * name that lives only on the prototype silently disappears — the same
     * detail that makes BullMQ's own `UnrecoverableError` survive that trip.
     */
    this.name = 'AgentConfigurationError';

    // Restores the prototype chain, so `instanceof` holds regardless of the
    // TypeScript target the file is compiled under.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Whether a caught value is one of ours.
 *
 * `instanceof` and nothing else. A name or message check would let an
 * untrusted provider error decide how the application classifies it — a
 * failing model that happened to produce `name: 'AgentConfigurationError'`
 * would talk the worker into abandoning its retries. Only code in this
 * repository can construct the class, so identity is the one signal a provider
 * cannot forge.
 */
export function isAgentConfigurationError(
  error: unknown,
): error is AgentConfigurationError {
  return error instanceof AgentConfigurationError;
}
