import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database';
import { RedisModule } from '../redis';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [DatabaseModule, RedisModule],
  controllers: [HealthController],
  providers: [HealthService],
  exports: [HealthService],
})
export class HealthModule {}
