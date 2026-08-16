import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { resolveAppLocale, type AppLocale } from '@repo/i18n-core';
import type { Response } from 'express';
import { I18nContext } from 'nestjs-i18n';

import { AppException, type AppErrorCode } from '../errors';
import {
  ValidationException,
  type ValidationIssue,
} from '../http/validation-issue';
import { AppI18nService } from './app-i18n.service';
import {
  ERROR_STATUS_CODES,
  ERROR_TRANSLATION_KEYS,
  VALIDATION_TRANSLATION_KEYS,
  errorCodeForStatus,
} from './error-translation-map';
import { nodeHeaderGetter, resolveLocaleFromHeaders } from './request-locale';

/** Shape of a single field failure inside a validation response. */
type FieldError = {
  /** Dotted path, so nested DTOs stay addressable: `address.city`. */
  field: string;
  /** Stable identifier — safe for clients to branch on. */
  code: string;
  /** Localized, for humans only. */
  message: string;
};

type ErrorResponseBody = {
  success: false;
  statusCode: number;
  errorCode: AppErrorCode;
  message: string;
  errors?: FieldError[];
  timestamp: string;
};

/**
 * The single exception filter for the HTTP boundary.
 *
 * It is the only place in the backend where a language enters an error:
 * everything upstream — domain code, the validation pipe — deals in stable
 * codes.
 *
 * Registered by `HttpInfrastructureModule`, not by the i18n module: error
 * serialization is an HTTP concern that consumes i18n rather than part of it.
 */
@Catch()
export class UnifiedExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(UnifiedExceptionFilter.name);

  constructor(private readonly i18n: AppI18nService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const locale = this.resolveLocale(host);

    const body = this.buildBody(exception, locale, host);

    response.status(body.statusCode).json(body);
  }

  private buildBody(
    exception: unknown,
    locale: AppLocale,
    host: ArgumentsHost,
  ): ErrorResponseBody {
    if (exception instanceof ValidationException) {
      return this.fromValidationException(exception, locale);
    }

    if (exception instanceof AppException) {
      return this.fromAppException(exception, locale);
    }

    if (exception instanceof HttpException) {
      return this.fromHttpException(exception, locale);
    }

    return this.fromUnknown(exception, locale, host);
  }

  private fromValidationException(
    exception: ValidationException,
    locale: AppLocale,
  ): ErrorResponseBody {
    const errors = exception.issues.map((issue) =>
      this.toFieldError(issue, locale),
    );

    return this.body('VALIDATION_ERROR', locale, { errors });
  }

  private fromAppException(
    exception: AppException,
    locale: AppLocale,
  ): ErrorResponseBody {
    return this.body(exception.code, locale, { args: exception.context });
  }

  /**
   * Preserves the status the exception was raised with.
   *
   * `errorCodeForStatus` only generalises a status into a code clients can
   * branch on; it must never feed back into the status. Otherwise a `422`
   * whose nearest code is `BAD_REQUEST` would be answered as `400`, and a
   * `503` would be flattened to `500` — localization silently rewriting HTTP
   * semantics.
   */
  private fromHttpException(
    exception: HttpException,
    locale: AppLocale,
  ): ErrorResponseBody {
    const status = exception.getStatus();

    return this.body(errorCodeForStatus(status), locale, {
      statusCode: status,
    });
  }

  /**
   * Anything unrecognised is reported as a generic localized failure. The
   * real error — message, stack, driver detail — goes to the logger and never
   * to the client, so i18n cannot become a channel for leaking stack traces,
   * SQL, or internal paths.
   */
  private fromUnknown(
    exception: unknown,
    locale: AppLocale,
    host: ArgumentsHost,
  ): ErrorResponseBody {
    const request = host.switchToHttp().getRequest<{
      method?: string;
      url?: string;
    }>();

    this.logger.error(
      `Unhandled exception on ${request?.method ?? '-'} ${request?.url ?? '-'}`,
      exception instanceof Error ? exception.stack : String(exception),
    );

    return this.body('INTERNAL_SERVER_ERROR', locale);
  }

  private body(
    errorCode: AppErrorCode,
    locale: AppLocale,
    options?: {
      errors?: FieldError[];
      args?: Record<string, unknown>;
      /** Overrides the code's default status, to preserve an original one. */
      statusCode?: number;
    },
  ): ErrorResponseBody {
    return {
      success: false,
      statusCode:
        options?.statusCode ??
        ERROR_STATUS_CODES[errorCode] ??
        HttpStatus.INTERNAL_SERVER_ERROR,
      errorCode,
      message: this.i18n.translateFor(
        locale,
        ERROR_TRANSLATION_KEYS[errorCode],
        options?.args,
      ),
      ...(options?.errors?.length ? { errors: options.errors } : {}),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * The locale for this error response.
   *
   * Normally `I18nContext` is present, having been established by
   * `I18nLanguageInterceptor`. But that interceptor runs *after* guards, so an
   * exception thrown by a guard — most importantly Better Auth's `AuthGuard`
   * rejecting an unauthenticated request — short-circuits before any context
   * exists. Without the fallback below, every 401 in the application would be
   * answered in Arabic regardless of what the caller asked for.
   *
   * The fallback re-runs the *same* pure precedence used by
   * `AppLocaleResolver`, so there is one locale algorithm rather than two. The
   * user preference is unavailable here by definition: if a guard rejected the
   * request, there is no authenticated user to have a preference.
   */
  private resolveLocale(host: ArgumentsHost): AppLocale {
    const context = I18nContext.current(host);
    if (context) return resolveAppLocale(context.lang);

    const request = host.switchToHttp().getRequest<{
      headers?: Record<string, string | string[] | undefined>;
    }>();

    return resolveAppLocale(
      resolveLocaleFromHeaders(nodeHeaderGetter(request?.headers ?? {})),
    );
  }

  /**
   * A validation code reaches its wording through exactly one map, whose
   * values are checked against the generated `I18nPath` — so there is no cast
   * here and no way for a hand-written key to slip past the type system.
   */
  private toFieldError(issue: ValidationIssue, locale: AppLocale): FieldError {
    return {
      field: issue.field,
      code: issue.code,
      message: this.i18n.translateFor(
        locale,
        VALIDATION_TRANSLATION_KEYS[issue.code],
        issue.args,
      ),
    };
  }
}
