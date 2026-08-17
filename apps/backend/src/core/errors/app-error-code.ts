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
