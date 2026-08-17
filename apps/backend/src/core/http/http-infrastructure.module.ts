import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';

import { UnifiedExceptionFilter } from './errors/unified-exception.filter';
import { ResponseInterceptor } from './response/response.interceptor';
import { ZodValidationPipe } from './validation/zod-validation.pipe';

@Module({
  providers: [
    {
      provide: APP_PIPE,
      useClass: ZodValidationPipe,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: ResponseInterceptor,
    },
    {
      provide: APP_FILTER,
      useClass: UnifiedExceptionFilter,
    },
  ],
})
export class HttpInfrastructureModule {}
