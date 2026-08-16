import { Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';

import { UnifiedExceptionFilter } from '../i18n/unified-exception.filter';
import { ZodValidationPipe } from './zod-validation.pipe';

/**
 * Owns the global HTTP request/response infrastructure.
 *
 * Both `APP_PIPE` and `APP_FILTER` are registered here — not inside the i18n
 * module. Validation and error serialization are HTTP concerns that *use*
 * i18n for wording; they are not part of it. Keeping the registration here
 * means the request pipeline is described in one place, and swapping the
 * translation layer would not disturb it.
 *
 * The filter class itself lives under `core/i18n` because translating an
 * error is its whole purpose; only its registration belongs to this module.
 */
@Module({
  providers: [
    {
      provide: APP_PIPE,
      useClass: ZodValidationPipe,
    },
    {
      provide: APP_FILTER,
      useClass: UnifiedExceptionFilter,
    },
  ],
})
export class HttpInfrastructureModule {}
