/**
 * Stable, machine-readable application error codes.
 *
 * Clients branch on `errorCode`, never on the localized human-readable
 * message. Domain and application code remain unaware of localization
 * and HTTP status mapping.
 */
export const APP_ERROR_CODES = [
  'USER_NOT_FOUND',
  'EMAIL_ALREADY_EXISTS',
  'INVALID_CREDENTIALS',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'BAD_REQUEST',
  'CONFLICT',
  'VALIDATION_ERROR',
  'TOO_MANY_REQUESTS',
  'INTERNAL_SERVER_ERROR',

  // Explicit lifecycle states let clients distinguish idempotent retries
  // from authorization, validation, and not-found failures.
  'ACCOUNT_ALREADY_DEACTIVATED',
  'ACCOUNT_NOT_DEACTIVATED',
  'ORGANIZATION_ALREADY_ARCHIVED',
  'ORGANIZATION_NOT_ARCHIVED',
  'ORGANIZATION_ARCHIVED',

  // Infrastructure and external-provider failures.
  'SERVICE_UNAVAILABLE',
  'QUEUE_UNAVAILABLE',
  'AI_PROVIDER_UNAVAILABLE',
  'RESOURCE_CONFLICT',
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

export function isAppErrorCode(value: unknown): value is AppErrorCode {
  return (
    typeof value === 'string' &&
    (APP_ERROR_CODES as readonly string[]).includes(value)
  );
}

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
