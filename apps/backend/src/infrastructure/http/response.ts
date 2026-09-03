/**
 * The HTTP response envelope: its shape, the interceptor that applies it, and
 * the decorator that opts an endpoint out of it.
 *
 * One file because the three are a single contract — the decorator is
 * meaningless without the interceptor that reads it, and the interceptor
 * exists only to produce these types.
 */
import {
  CallHandler,
  CustomDecorator,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface PaginationMeta {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

export interface ApiMeta {
  requestId: string;
  timestamp: string;
  pagination?: PaginationMeta;
}

export interface ApiSuccessResponse<T = unknown> {
  success: true;
  data: T;
  meta: ApiMeta;
}

export interface ApiFieldError {
  field: string;
  code: string;
  message: string;
}

export interface ApiErrorDetail {
  code: string;
  message: string;
  details?: ApiFieldError[] | Record<string, unknown>;
}

export interface ApiErrorResponse {
  success: false;
  error: ApiErrorDetail;
  meta: ApiMeta;
}

export type ApiResponse<T = unknown> = ApiSuccessResponse<T> | ApiErrorResponse;

export const IS_RAW_RESPONSE_KEY = 'isRawResponse';

/**
 * Opts out an endpoint from `ResponseInterceptor` JSON envelope wrapping.
 *
 * Use for protocol endpoints such as Server-Sent Events (`text/event-stream`),
 * file downloads, or binary streams where wrapping in `{ success: true, data }`
 * would violate the protocol.
 *
 * Note: HTTP 204 No Content and `/api/auth/*` routes are bypassed automatically;
 * `@RawResponse()` is for explicit protocol-level bypasses on `/api/*` routes.
 */
export const RawResponse = (): CustomDecorator<string> =>
  SetMetadata(IS_RAW_RESPONSE_KEY, true);

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<
  T,
  ApiSuccessResponse<T> | T
> {
  constructor(private readonly reflector: Reflector) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiSuccessResponse<T> | T> {
    const httpContext = context.switchToHttp();
    const request = httpContext.getRequest<Request & { id?: string }>();
    const response = httpContext.getResponse<Response>();

    // 1. Bypass explicitly decorated @RawResponse() endpoints
    const isRaw = this.reflector.getAllAndOverride<boolean>(
      IS_RAW_RESPONSE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isRaw) {
      return next.handle();
    }

    return next.handle().pipe(
      map((data: unknown) => {
        // 2. Automatic 204 No Content bypass
        if (response.statusCode === 204) {
          return data as T;
        }

        const requestId =
          request.id ??
          (response.getHeader('X-Request-ID') as string) ??
          'req_unknown';

        let responseData = data;
        let paginationMeta: PaginationMeta | undefined;

        // Extract pagination metadata if data contains an explicit pagination structure
        if (
          data !== null &&
          typeof data === 'object' &&
          !Array.isArray(data) &&
          'items' in data &&
          'pagination' in data
        ) {
          const paginated = data as {
            items: unknown;
            pagination: PaginationMeta;
          };
          responseData = paginated.items;
          paginationMeta = paginated.pagination;
        }

        const successResponse: ApiSuccessResponse<unknown> = {
          success: true,
          data: responseData,
          meta: {
            requestId,
            timestamp: new Date().toISOString(),
            ...(paginationMeta ? { pagination: paginationMeta } : {}),
          },
        };

        return successResponse as ApiSuccessResponse<T>;
      }),
    );
  }
}
