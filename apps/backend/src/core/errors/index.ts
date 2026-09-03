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

  'LAST_SUPER_ADMIN',

  // Control plane. A disabled feature is 403 rather than 404: the route exists
  // and the caller may well be entitled to it, but the platform has switched
  // the capability off. A missing credential is 503, because it is an
  // operator-fixable configuration gap, not something the caller did wrong.
  'FEATURE_DISABLED',
  'SECRET_NOT_CONFIGURED',
  'SECRET_UNREADABLE',

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
  context?: Record<string, unknown>;

  publicDetails?: Record<string, unknown>;
}

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
