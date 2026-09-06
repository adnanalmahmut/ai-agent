import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { resolveAppLocale, type AppLocale } from '@repo/i18n-core';
import type { Request, Response } from 'express';
import { I18nContext } from 'nestjs-i18n';

import {
  AppException,
  InvariantViolationError,
  type AppErrorCode,
} from '../../core/errors';
import { ValidationException, type ValidationIssue } from './validation';
import type {
  ApiBusinessErrorDetails,
  ApiErrorDetails,
  ApiErrorResponse,
  ApiFieldError,
  ApiValidationErrorDetails,
} from './response';
import { AppI18nService } from '../i18n/app-i18n.service';
import {
  ERROR_STATUS_CODES,
  ERROR_TRANSLATION_KEYS,
  VALIDATION_TRANSLATION_KEYS,
  errorCodeForStatus,
} from '../i18n/error-translation-map';
import {
  nodeHeaderGetter,
  resolveLocaleFromHeaders,
} from '../i18n/request-locale';

/**
 * How deep a public detail may nest. The readiness probe reports a dependency
 * map, which is two, and nothing legitimate here is a tree.
 */
const MAX_DETAIL_DEPTH = 4;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;

  const prototype: unknown = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

/**
 * Keeps the part of a value that is safe to send, and returns `undefined` for
 * the part that is not.
 *
 * A public detail is meant to be a sentence or a number the caller can act on.
 * Anything else -- an Error, a Prisma exception, a Date, a class instance, a
 * function -- is a value that was reached for rather than chosen, and
 * serialising it is how a stack trace, a SQL fragment, or a provider payload
 * leaves the process. So JSON scalars, plain objects, and arrays of those
 * survive to a bounded depth, and everything else is dropped rather than
 * described.
 */
function publicValue(value: unknown, depth: number): unknown {
  if (value === null) return null;

  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }

  if (depth >= MAX_DETAIL_DEPTH) return undefined;

  if (Array.isArray(value)) {
    return value
      .map((item) => publicValue(item, depth + 1))
      .filter((item) => item !== undefined);
  }

  if (isPlainObject(value)) return publicRecord(value, depth + 1);

  return undefined;
}

function publicRecord(
  source: Record<string, unknown>,
  depth: number,
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    // The discriminator belongs to the filter. A producer that sets it -- by
    // accident or otherwise -- must not be able to make a business refusal
    // read as a validated one.
    if (key === 'kind') continue;

    const cleaned = publicValue(value, depth);
    if (cleaned !== undefined) kept[key] = cleaned;
  }

  return kept;
}

/**
 * Reads a producer's `publicDetails` bag into the declared contract.
 *
 * The error code decides which of the two shapes it is: `VALIDATION_ERROR`
 * means the caller sent something the endpoint could not accept, whatever the
 * producer used to describe it, so `issues` and a single `reason` both become
 * the same list of messages. Every other code is a domain refusal and keeps
 * its bag as it stands.
 */
function publicDetails(
  code: AppErrorCode,
  source: unknown,
): ApiErrorDetails | undefined {
  if (!isPlainObject(source)) return undefined;

  const kept = publicRecord(source, 0);

  if (code === 'VALIDATION_ERROR') return validationDetails(kept);

  return Object.keys(kept).length > 0
    ? ({ kind: 'business', ...kept } satisfies ApiBusinessErrorDetails)
    : undefined;
}

function validationDetails(
  kept: Record<string, unknown>,
): ApiValidationErrorDetails | undefined {
  const messages: string[] = [];

  if (Array.isArray(kept.issues)) {
    for (const issue of kept.issues) {
      if (typeof issue === 'string') messages.push(issue);
    }
  }

  if (typeof kept.reason === 'string') messages.push(kept.reason);

  return messages.length > 0
    ? { kind: 'validation', fields: [], messages }
    : undefined;
}

@Catch()
export class UnifiedExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(UnifiedExceptionFilter.name);

  constructor(private readonly i18n: AppI18nService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const httpHost = host.switchToHttp();
    const request = httpHost.getRequest<Request & { id?: string }>();
    const response = httpHost.getResponse<Response>();

    const locale = this.resolveLocale(host);
    const requestId =
      request?.id ??
      (response.getHeader('X-Request-ID') as string) ??
      'req_unknown';

    const { status, body } = this.buildErrorResponse(
      exception,
      locale,
      requestId,
      host,
    );

    response.status(status).json(body);
  }

  private buildErrorResponse(
    exception: unknown,
    locale: AppLocale,
    requestId: string,
    host: ArgumentsHost,
  ): { status: number; body: ApiErrorResponse } {
    if (exception instanceof ValidationException) {
      return this.fromValidationException(exception, locale, requestId);
    }

    if (exception instanceof AppException) {
      return this.fromAppException(exception, locale, requestId);
    }

    if (exception instanceof HttpException) {
      return this.fromHttpException(exception, locale, requestId);
    }

    return this.fromUnknown(exception, locale, requestId, host);
  }

  private fromValidationException(
    exception: ValidationException,
    locale: AppLocale,
    requestId: string,
  ): { status: number; body: ApiErrorResponse } {
    const fields = exception.issues.map((issue) =>
      this.toFieldError(issue, locale),
    );

    return this.formatEnvelope(
      HttpStatus.BAD_REQUEST,
      'VALIDATION_ERROR',
      locale,
      requestId,
      { details: { kind: 'validation', fields, messages: [] } },
    );
  }

  private fromAppException(
    exception: AppException,
    locale: AppLocale,
    requestId: string,
  ): { status: number; body: ApiErrorResponse } {
    const status =
      ERROR_STATUS_CODES[exception.code] ?? HttpStatus.INTERNAL_SERVER_ERROR;

    return this.formatEnvelope(status, exception.code, locale, requestId, {
      args: exception.context,
      details: publicDetails(exception.code, exception.publicDetails),
    });
  }

  private fromHttpException(
    exception: HttpException,
    locale: AppLocale,
    requestId: string,
  ): { status: number; body: ApiErrorResponse } {
    const status = exception.getStatus();
    const code = errorCodeForStatus(status);
    const exceptionResponse = exception.getResponse();

    const carried =
      typeof exceptionResponse === 'object' && exceptionResponse !== null
        ? (exceptionResponse as { details?: unknown }).details
        : undefined;

    return this.formatEnvelope(status, code, locale, requestId, {
      details: publicDetails(code, carried),
    });
  }

  private fromUnknown(
    exception: unknown,
    locale: AppLocale,
    requestId: string,
    host: ArgumentsHost,
  ): { status: number; body: ApiErrorResponse } {
    const request = host.switchToHttp().getRequest<Request>();

    // Handle Express HttpErrors (e.g. body-parser PayloadTooLargeError with status 413)
    if (
      typeof exception === 'object' &&
      exception !== null &&
      ('status' in exception || 'statusCode' in exception)
    ) {
      const errObj = exception as { status?: number; statusCode?: number };
      const status = errObj.status ?? errObj.statusCode;
      if (typeof status === 'number' && status >= 400 && status < 600) {
        const code = errorCodeForStatus(status);
        return this.formatEnvelope(status, code, locale, requestId);
      }
    }

    // Named separately in the log because it is a different kind of failure to
    // go and look at: not an unexpected error from somewhere out there, but a
    // state this system said could not happen. The answer is the same 500 --
    // the caller cannot fix an invariant either way.
    const summary =
      exception instanceof InvariantViolationError
        ? `Invariant violated on ${request?.method ?? '-'} ${request?.url ?? '-'} [requestId: ${requestId}]: ${exception.message}`
        : `Unhandled exception on ${request?.method ?? '-'} ${request?.url ?? '-'} [requestId: ${requestId}]`;

    this.logger.error(
      summary,
      exception instanceof Error ? exception.stack : String(exception),
    );

    return this.formatEnvelope(
      HttpStatus.INTERNAL_SERVER_ERROR,
      'INTERNAL_SERVER_ERROR',
      locale,
      requestId,
    );
  }

  private formatEnvelope(
    status: number,
    code: AppErrorCode,
    locale: AppLocale,
    requestId: string,
    options?: {
      details?: ApiErrorDetails;
      args?: Record<string, unknown>;
    },
  ): { status: number; body: ApiErrorResponse } {
    const message = this.i18n.translateFor(
      locale,
      ERROR_TRANSLATION_KEYS[code],
      options?.args,
    );

    const body: ApiErrorResponse = {
      success: false,
      error: {
        code,
        message,
        ...(options?.details ? { details: options.details } : {}),
      },
      meta: {
        requestId,
        timestamp: new Date().toISOString(),
      },
    };

    return { status, body };
  }

  private resolveLocale(host: ArgumentsHost): AppLocale {
    const context = I18nContext.current(host);
    if (context) return resolveAppLocale(context.lang);

    const request = host.switchToHttp().getRequest<Request>();
    return resolveAppLocale(
      resolveLocaleFromHeaders(nodeHeaderGetter(request?.headers ?? {})),
    );
  }

  private toFieldError(
    issue: ValidationIssue,
    locale: AppLocale,
  ): ApiFieldError {
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
