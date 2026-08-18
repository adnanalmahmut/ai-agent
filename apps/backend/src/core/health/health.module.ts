import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database';
import { RedisModule } from '../redis';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/**
 * `RedisModule` is imported here rather than in `AppModule`.
 *
 * The health probe is the API's only reason to hold a Redis connection today,
 * and importing it where it is used keeps that true: nothing in a request
 * handler can inject `RedisService` without a module change that says so. The
 * `ProcessReadiness` the probe also reads comes from the global
 * `LifecycleModule`, because the shutdown sequence has to reach the same
 * instance.
 */
@Module({
  imports: [DatabaseModule, RedisModule],
  controllers: [HealthController],
  providers: [HealthService],
  exports: [HealthService],
})
export class HealthModule {}
