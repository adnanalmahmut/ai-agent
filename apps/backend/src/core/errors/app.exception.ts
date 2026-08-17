import type { AppErrorCode } from './app-error-code';

/**
 * The only application exception business logic should throw.
 *
 * Carries a stable error code and structured context without coupling the
 * domain to HTTP status codes, localization, or user-facing messages.
 */
export class AppException extends Error {
  constructor(
    readonly code: AppErrorCode,
    /**
     * Internal structured context for safe logging and message interpolation.
     * Never include secrets or serialize it directly into API responses.
     */
    readonly context?: Record<string, unknown>,
  ) {
    super(code);
    this.name = 'AppException';
  }
}
