/**
 * Stable, machine-readable error identifiers.
 *
 * These are the API contract. Clients branch on `errorCode`; the human
 * `message` that travels next to it is a localized presentation detail and
 * may change wording or language at any time without being a breaking change.
 *
 * Domain and application code throws these codes and nothing else — it never
 * knows a language, a translation key, or an HTTP status.
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

  // Account and organization lifecycle. These exist because "already in that
  // state" is a genuinely different machine condition from "not allowed" or
  // "not found" — a client retrying a deactivation needs to distinguish an
  // idempotent no-op from a permission failure, and it must be able to do so
  // without parsing a localized sentence.
  'ACCOUNT_ALREADY_DEACTIVATED',
  'ACCOUNT_NOT_DEACTIVATED',
  'ORGANIZATION_ALREADY_ARCHIVED',
  'ORGANIZATION_NOT_ARCHIVED',
  'ORGANIZATION_ARCHIVED',
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

export function isAppErrorCode(value: unknown): value is AppErrorCode {
  return (
    typeof value === 'string' &&
    (APP_ERROR_CODES as readonly string[]).includes(value)
  );
}
