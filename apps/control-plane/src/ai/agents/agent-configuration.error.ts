export class AgentConfigurationError extends Error {
  constructor(message: string) {
    super(message);

    this.name = 'AgentConfigurationError';

    // Restores the prototype chain, so `instanceof` holds regardless of the
    // TypeScript target the file is compiled under.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isAgentConfigurationError(
  error: unknown,
): error is AgentConfigurationError {
  return error instanceof AgentConfigurationError;
}
