import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { IS_RAW_RESPONSE_KEY } from './raw-response.decorator';
import type { ApiSuccessResponse, PaginationMeta } from './response.types';

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
