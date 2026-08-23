import { HttpStatus } from '@nestjs/common';

import type { AppErrorCode } from '../errors';
import type { ValidationIssueCode } from '../http/validation';
import type { I18nPath } from '../../generated/i18n.generated';

/**
 * HTTP-boundary knowledge about domain error codes.
 *
 * Both maps live here so the domain never has to know either half: business
 * code throws `AppException('USER_NOT_FOUND')` and remains ignorant of the
 * translation key `errors.USER_NOT_FOUND` and of the 404 status.
 *
 * Adding a code to `APP_ERROR_CODES` without adding it here is a compile
 * error — `Record<AppErrorCode, …>` is exhaustive on purpose — and the value
 * side is checked against `I18nPath`, so a key that no translation file
 * defines fails to compile rather than surfacing to a user as raw text.
 */
export const ERROR_TRANSLATION_KEYS = {
  USER_NOT_FOUND: 'errors.USER_NOT_FOUND',
  EMAIL_ALREADY_EXISTS: 'errors.EMAIL_ALREADY_EXISTS',
  INVALID_CREDENTIALS: 'errors.INVALID_CREDENTIALS',
  UNAUTHORIZED: 'errors.UNAUTHORIZED',
  FORBIDDEN: 'errors.FORBIDDEN',
  NOT_FOUND: 'errors.NOT_FOUND',
  BAD_REQUEST: 'errors.BAD_REQUEST',
  CONFLICT: 'errors.CONFLICT',
  VALIDATION_ERROR: 'errors.VALIDATION_ERROR',
  TOO_MANY_REQUESTS: 'errors.TOO_MANY_REQUESTS',
  INTERNAL_SERVER_ERROR: 'errors.INTERNAL_SERVER_ERROR',
  ACCOUNT_ALREADY_DEACTIVATED: 'errors.ACCOUNT_ALREADY_DEACTIVATED',
  ACCOUNT_NOT_DEACTIVATED: 'errors.ACCOUNT_NOT_DEACTIVATED',
  ORGANIZATION_ALREADY_ARCHIVED: 'errors.ORGANIZATION_ALREADY_ARCHIVED',
  ORGANIZATION_NOT_ARCHIVED: 'errors.ORGANIZATION_NOT_ARCHIVED',
  ORGANIZATION_ARCHIVED: 'errors.ORGANIZATION_ARCHIVED',
  FEATURE_DISABLED: 'errors.FEATURE_DISABLED',
  SECRET_NOT_CONFIGURED: 'errors.SECRET_NOT_CONFIGURED',
  SECRET_UNREADABLE: 'errors.SECRET_UNREADABLE',
  SERVICE_UNAVAILABLE: 'errors.SERVICE_UNAVAILABLE',
  QUEUE_UNAVAILABLE: 'errors.QUEUE_UNAVAILABLE',
  AI_PROVIDER_UNAVAILABLE: 'errors.AI_PROVIDER_UNAVAILABLE',
  RESOURCE_CONFLICT: 'errors.RESOURCE_CONFLICT',
} as const satisfies Record<AppErrorCode, I18nPath>;

export const ERROR_STATUS_CODES = {
  USER_NOT_FOUND: HttpStatus.NOT_FOUND,
  EMAIL_ALREADY_EXISTS: HttpStatus.CONFLICT,
  INVALID_CREDENTIALS: HttpStatus.UNAUTHORIZED,
  UNAUTHORIZED: HttpStatus.UNAUTHORIZED,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  BAD_REQUEST: HttpStatus.BAD_REQUEST,
  CONFLICT: HttpStatus.CONFLICT,
  VALIDATION_ERROR: HttpStatus.BAD_REQUEST,
  TOO_MANY_REQUESTS: HttpStatus.TOO_MANY_REQUESTS,
  INTERNAL_SERVER_ERROR: HttpStatus.INTERNAL_SERVER_ERROR,
  // 409, not 400: the request was well-formed and the caller was allowed to
  // make it — the resource is simply already in the requested state.
  ACCOUNT_ALREADY_DEACTIVATED: HttpStatus.CONFLICT,
  ACCOUNT_NOT_DEACTIVATED: HttpStatus.CONFLICT,
  ORGANIZATION_ALREADY_ARCHIVED: HttpStatus.CONFLICT,
  ORGANIZATION_NOT_ARCHIVED: HttpStatus.CONFLICT,
  // 403: the organization exists and the caller may well be a member, but the
  // organization's lifecycle state forbids the operation.
  ORGANIZATION_ARCHIVED: HttpStatus.FORBIDDEN,
  // 403: the capability is switched off for this caller, which is an
  // authorization-shaped answer even though no permission was missing.
  FEATURE_DISABLED: HttpStatus.FORBIDDEN,
  // 503, not 500: nothing is broken, an operator simply has not supplied the
  // credential yet, and the request may succeed unchanged once they do.
  SECRET_NOT_CONFIGURED: HttpStatus.SERVICE_UNAVAILABLE,
  SECRET_UNREADABLE: HttpStatus.SERVICE_UNAVAILABLE,
  SERVICE_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  QUEUE_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  AI_PROVIDER_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  RESOURCE_CONFLICT: HttpStatus.CONFLICT,
} as const satisfies Record<AppErrorCode, HttpStatus>;

/**
 * Field-level counterpart of `ERROR_TRANSLATION_KEYS`, and the *only* route
 * from a validation code to a translation key.
 *
 * Exhaustive in both directions: adding a code to `VALIDATION_ISSUE_CODES`
 * without a key here fails to compile, and a key that no translation file
 * defines fails against `I18nPath`.
 */
export const VALIDATION_TRANSLATION_KEYS = {
  REQUIRED: 'validation.REQUIRED',
  INVALID_STRING: 'validation.INVALID_STRING',
  INVALID_NUMBER: 'validation.INVALID_NUMBER',
  INVALID_INT: 'validation.INVALID_INT',
  INVALID_BOOLEAN: 'validation.INVALID_BOOLEAN',
  INVALID_DATE: 'validation.INVALID_DATE',
  INVALID_EMAIL: 'validation.INVALID_EMAIL',
  INVALID_UUID: 'validation.INVALID_UUID',
  INVALID_URL: 'validation.INVALID_URL',
  INVALID_FORMAT: 'validation.INVALID_FORMAT',
  INVALID_ENUM: 'validation.INVALID_ENUM',
  INVALID_VALUE: 'validation.INVALID_VALUE',
  MIN_LENGTH: 'validation.MIN_LENGTH',
  MAX_LENGTH: 'validation.MAX_LENGTH',
  MIN: 'validation.MIN',
  MAX: 'validation.MAX',
  NOT_ARRAY: 'validation.NOT_ARRAY',
  ARRAY_MIN_SIZE: 'validation.ARRAY_MIN_SIZE',
  ARRAY_MAX_SIZE: 'validation.ARRAY_MAX_SIZE',
  UNRECOGNIZED_KEY: 'validation.UNRECOGNIZED_KEY',
} as const satisfies Record<ValidationIssueCode, I18nPath>;

const STATUS_ERROR_CODES: Partial<Record<number, AppErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: 'BAD_REQUEST',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.TOO_MANY_REQUESTS]: 'TOO_MANY_REQUESTS',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'SERVICE_UNAVAILABLE',
};

export function errorCodeForStatus(status: number): AppErrorCode {
  return (
    STATUS_ERROR_CODES[status] ??
    (status >= 500 ? 'INTERNAL_SERVER_ERROR' : 'BAD_REQUEST')
  );
}
