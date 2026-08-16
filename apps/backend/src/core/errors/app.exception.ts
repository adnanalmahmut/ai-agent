import type { AppErrorCode } from './app-error-code';

/**
 * The one exception business logic is allowed to throw.
 *
 * Deliberately *not* an `HttpException` and deliberately without a message
 * string: the domain states what went wrong, and the HTTP boundary decides
 * the status code, the language, and the wording.
 *
 * ```ts
 * // in a use case / service
 * throw new AppException('USER_NOT_FOUND', { userId });
 * ```
 *
 * Never do this instead:
 * ```ts
 * throw new Error('User not found');          // language in the domain
 * throw new Error(i18n.t('errors.USER_NOT_FOUND')); // translation in the domain
 * ```
 */
export class AppException extends Error {
  constructor(
    readonly code: AppErrorCode,
    /**
     * Structured detail for logging and for interpolation into the localized
     * message. Never rendered verbatim into a response.
     */
    readonly context?: Record<string, unknown>,
  ) {
    super(code);
    this.name = 'AppException';
  }
}
