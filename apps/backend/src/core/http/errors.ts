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

import { AppException, type AppErrorCode } from '../errors';
import { ValidationException, type ValidationIssue } from './validation';
import type { ApiErrorResponse, ApiFieldError } from './response';
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
 * The single exception filter for the HTTP boundary.
 *
 * Registered by `HttpInfrastructureModule`.
 */
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
    const details = exception.issues.map((issue) =>
      this.toFieldError(issue, locale),
    );

    return this.formatEnvelope(
      HttpStatus.BAD_REQUEST,
      'VALIDATION_ERROR',
      locale,
      requestId,
      { details },
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
      details: exception.publicDetails,
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

    let details: Record<string, unknown> | undefined;
    if (
      typeof exceptionResponse === 'object' &&
      exceptionResponse !== null &&
      'details' in exceptionResponse
    ) {
      details = (exceptionResponse as { details: Record<string, unknown> })
        .details;
    }

    return this.formatEnvelope(status, code, locale, requestId, { details });
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

    this.logger.error(
      `Unhandled exception on ${request?.method ?? '-'} ${request?.url ?? '-'} [requestId: ${requestId}]`,
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
      details?: ApiFieldError[] | Record<string, unknown>;
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
