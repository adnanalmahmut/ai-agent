import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';

import { redisConfig } from '../config';
import { buildRedisConnectionOptions } from './redis.options';

/** What a probe can say about Redis without guessing. */
export type RedisProbe = {
  status: 'up' | 'down';
  latencyMs?: number;
};

/**
 * The general-purpose Redis client: ephemeral coordination state only.
 *
 * Stream buffers, rate-limit windows, idempotency markers, short-lived locks.
 * Never a system of record — every durable fact belongs to PostgreSQL, and this
 * service is written on the assumption that losing the entire Redis instance
 * costs throughput and nothing else.
 *
 * Two consequences of that assumption are visible in the code:
 *
 * - Construction never blocks and never throws. ioredis connects in the
 *   background, so an unreachable Redis produces a degraded process rather than
 *   a process that will not start. The API in particular has no business
 *   refusing to serve `GET /health/live` because a cache is down.
 * - There is no `RedisLockService` here, and adding one would be a mistake.
 *   A general-purpose distributed lock invites locking as a default, and
 *   almost every invariant this system needs is better served by a PostgreSQL
 *   UNIQUE constraint, a conditional `UPDATE ... WHERE status = ...`, a BullMQ
 *   `jobId`, or queue concurrency — all of which survive a Redis restart,
 *   which a lock does not. Locks here should be introduced one at a time,
 *   each next to the specific invariant it protects.
 */
@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly client: Redis;

  /**
   * Tracks whether the client has *ever* connected.
   *
   * Distinguishes "starting up" from "was working and broke", which is the
   * difference between a deployment that should keep waiting and an incident.
   */
  private everConnected = false;

  constructor(
    @Inject(redisConfig.KEY)
    config: ConfigType<typeof redisConfig>,
    private readonly logger: PinoLogger,
  ) {
    const { url, ...options } = buildRedisConnectionOptions('general', config);

    this.client = new Redis(url, options);

    /**
     * Not optional. ioredis emits `error` on every failed connection attempt,
     * and an EventEmitter with no `error` listener throws — so the absence of
     * this handler would turn a Redis outage into a crashed process, which is
     * the exact opposite of the degradation this service is built for.
     */
    this.client.on('error', (error: Error) => {
      this.logger.warn(
        { err: { name: error.name, message: error.message } },
        'Redis connection error; coordination features are degraded',
      );
    });

    this.client.on('ready', () => {
      this.everConnected = true;
      this.logger.info('Redis connection ready');
    });
  }

  /**
   * The client, for coordination state.
   *
   * Callers must treat every command as failable: with the offline queue
   * disabled, a command issued while disconnected rejects immediately by
   * design. That is the contract, not a rough edge — it is what keeps a Redis
   * outage from becoming request latency.
   */
  get connection(): Redis {
    return this.client;
  }

  /** ioredis' own view: `ready` means commands will be attempted. */
  get isReady(): boolean {
    return this.client.status === 'ready';
  }

  get hasEverConnected(): boolean {
    return this.everConnected;
  }

  /**
   * Round-trips a `PING`.
   *
   * Bounded by the configured `commandTimeout` and by a disabled offline queue,
   * so this cannot become the reason a readiness probe hangs — a health check
   * that blocks is worse than one that reports failure.
   */
  async probe(): Promise<RedisProbe> {
    const startedAt = process.hrtime.bigint();

    try {
      await this.client.ping();

      return {
        status: 'up',
        latencyMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      };
    } catch {
      return { status: 'down' };
    }
  }

  /**
   * Closes the connection during shutdown.
   *
   * `quit()` first, so replies already in flight are drained rather than
   * abandoned; `disconnect()` if that fails, because a shutdown path must
   * terminate. An unreachable Redis makes `quit()` reject, and a shutdown
   * sequence that propagated that error would strand every step after it.
   */
  async onApplicationShutdown(): Promise<void> {
    if (this.client.status === 'end') return;

    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
