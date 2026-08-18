import { Module } from '@nestjs/common';

import { RedisService } from './redis.service';

/**
 * The general-purpose Redis connection, and nothing else.
 *
 * Queue connections are not provided here even though they are Redis
 * connections, because they are not interchangeable with this one: a BullMQ
 * worker's connection must retry forever and must never have a command timeout,
 * while this one must do the opposite. Exporting a single "the Redis client"
 * provider would make the wrong client one injection away, so
 * `src/infrastructure/queue` derives its own from the shared role table in
 * `redis-connection.options.ts`.
 *
 * Imported by both process entrypoints. The API needs it to answer readiness
 * probes and, later, to serve stream buffers; the worker needs it for the same
 * coordination state its jobs write.
 */
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
