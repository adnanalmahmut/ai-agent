import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';

import { redisConfig } from '../config';
import { buildRedisConnectionOptions } from './redis.options';

export type RedisProbe = {
  status: 'up' | 'down';
  latencyMs?: number;
};

@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly client: Redis;

  private everConnected = false;

  constructor(
    @Inject(redisConfig.KEY)
    config: ConfigType<typeof redisConfig>,
    private readonly logger: PinoLogger,
  ) {
    const { url, ...options } = buildRedisConnectionOptions('general', config);

    this.client = new Redis(url, options);

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

  get connection(): Redis {
    return this.client;
  }

  get isReady(): boolean {
    return this.client.status === 'ready';
  }

  get hasEverConnected(): boolean {
    return this.everConnected;
  }

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

  async onApplicationShutdown(): Promise<void> {
    if (this.client.status === 'end') return;

    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
