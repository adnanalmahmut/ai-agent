import type { ConfigType } from '@nestjs/config';

import type { redisConfig } from '../config';

export type RedisRole = 'general' | 'queue-producer' | 'queue-worker';

const reconnectAfter = (attempt: number): number =>
  Math.min(50 * 2 ** Math.min(attempt, 7), 5_000);

export type RedisConnectionOptions = {
  url: string;
  connectTimeout: number;
  retryStrategy: (attempt: number) => number;
  enableReadyCheck: boolean;
  disconnectTimeout: number;
  enableOfflineQueue: boolean;
  keyPrefix?: string;
  commandTimeout?: number;
  maxRetriesPerRequest?: number | null;
};

export function buildRedisConnectionOptions(
  role: RedisRole,
  config: ConfigType<typeof redisConfig>,
): RedisConnectionOptions {
  const base: Omit<RedisConnectionOptions, 'enableOfflineQueue'> = {
    url: config.url,
    connectTimeout: config.connectTimeoutMs,
    retryStrategy: reconnectAfter,
    enableReadyCheck: true,
    disconnectTimeout: config.commandTimeoutMs,
  };

  switch (role) {
    case 'general':
      return {
        ...base,
        keyPrefix: config.keyPrefix,
        commandTimeout: config.commandTimeoutMs,
        maxRetriesPerRequest: config.maxRetriesPerRequest,
        enableOfflineQueue: false,
      };

    case 'queue-producer':
      return {
        ...base,
        commandTimeout: config.commandTimeoutMs,
        maxRetriesPerRequest: config.maxRetriesPerRequest,
        enableOfflineQueue: true,
      };

    case 'queue-worker':
      return {
        ...base,
        maxRetriesPerRequest: null,
        enableOfflineQueue: true,
      };
  }
}
