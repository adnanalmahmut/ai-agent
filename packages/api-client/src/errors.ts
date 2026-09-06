import { NO_ERROR_DETAILS, type ApiErrorDetails } from './protocol';

/**
 * The request never got an answer: the network was down, the origin refused
 * the connection, or the caller aborted. Distinct from `ApiError`, which is
 * the API answering — a refusal is information, and a silence is not.
 */
export class ApiUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('The platform API could not be reached');
    this.name = 'ApiUnavailableError';
    this.cause = cause;
  }
}

/** The API answered, and the answer was a refusal. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly details: ApiErrorDetails = NO_ERROR_DETAILS,
  ) {
    super(`Platform API responded with ${status}`);
    this.name = 'ApiError';
  }
}
