import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { RedisModule } from '../redis';
import { RateLimitInterceptor } from './rate-limit.interceptor';
import { RateLimiterPort } from './rate-limiter.port';
import { RedisRateLimiterAdapter } from './redis-rate-limiter.adapter';

@Global()
@Module({
  imports: [RedisModule],
  providers: [
    RedisRateLimiterAdapter,
    { provide: RateLimiterPort, useExisting: RedisRateLimiterAdapter },
    { provide: APP_INTERCEPTOR, useClass: RateLimitInterceptor },
  ],
  exports: [RateLimiterPort],
})
export class RateLimitModule {}
