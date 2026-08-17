import type { AppErrorCode } from './app-error-code';

export interface AppExceptionOptions {
  /**
   * Internal structured context for server-side logging and translation
   * message interpolation. Never serialized directly into API responses.
   */
  context?: Record<string, unknown>;

  /**
   * Explicit machine-readable details safe to expose in the public API error
   * response (`error.details`). Only populate this with non-sensitive details
   * (e.g. dependency probe status).
   */
  publicDetails?: Record<string, unknown>;
}

/**
 * The only application exception business logic should throw.
 *
 * Carries a stable error code, optional internal logging context, and
 * explicitly separated public response details without coupling the domain
 * to HTTP status codes, localization, or user-facing messages.
 */
export class AppException extends Error {
  readonly context?: Record<string, unknown>;
  readonly publicDetails?: Record<string, unknown>;

  constructor(
    readonly code: AppErrorCode,
    contextOrOptions?: Record<string, unknown> | AppExceptionOptions,
  ) {
    super(code);
    this.name = 'AppException';

    if (contextOrOptions) {
      if (
        'context' in contextOrOptions ||
        'publicDetails' in contextOrOptions
      ) {
        const opts = contextOrOptions as AppExceptionOptions;
        this.context = opts.context;
        this.publicDetails = opts.publicDetails;
      } else {
        // Direct context bag passed: new AppException('USER_NOT_FOUND', { userId })
        this.context = contextOrOptions as Record<string, unknown>;
      }
    }
  }
}
