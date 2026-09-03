import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import type { PinoLogger } from 'nestjs-pino';

import {
  buildRedisConnectionOptions,
  type RedisRole,
} from '../../../../src/infrastructure/redis/redis.options';
import { RedisService } from '../../../../src/infrastructure/redis/redis.service';

const config = {
  url: 'redis://localhost:6379',
  keyPrefix: 'app:',
  connectTimeoutMs: 5_000,
  commandTimeoutMs: 2_000,
  maxRetriesPerRequest: 2,
};

const ROLES: RedisRole[] = ['general', 'queue-producer', 'queue-worker'];

describe('buildRedisConnectionOptions', () => {
  it('points every role at the configured URL with a bounded connect timeout', () => {
    for (const role of ROLES) {
      expect(buildRedisConnectionOptions(role, config)).toMatchObject({
        url: 'redis://localhost:6379',
        connectTimeout: 5_000,
      });
    }
  });

  it('bounds a close by the command timeout rather than the ioredis default', () => {
    for (const role of ROLES) {
      expect(buildRedisConnectionOptions(role, config).disconnectTimeout).toBe(
        2_000,
      );
    }

    expect(
      buildRedisConnectionOptions('general', {
        ...config,
        commandTimeoutMs: 250,
      }).disconnectTimeout,
    ).toBe(250);
  });

  it('gives every role a capped, unlimited-attempt reconnection policy', () => {
    for (const role of ROLES) {
      const { retryStrategy } = buildRedisConnectionOptions(role, config);

      expect(typeof retryStrategy(1)).toBe('number');
      expect(typeof retryStrategy(1_000)).toBe('number');

      expect(retryStrategy(1)).toBeLessThan(retryStrategy(5));
      expect(retryStrategy(1_000)).toBe(5_000);
    }
  });

  describe('general (request- and probe-facing)', () => {
    const options = buildRedisConnectionOptions('general', config);

    it('fails commands immediately while disconnected', () => {
      expect(options.enableOfflineQueue).toBe(false);
    });

    it('bounds both the command and the retry budget', () => {
      expect(options.commandTimeout).toBe(2_000);
      expect(options.maxRetriesPerRequest).toBe(2);
    });

    it('is the only role that carries a client-side key prefix', () => {
      expect(options.keyPrefix).toBe('app:');

      expect(
        buildRedisConnectionOptions('queue-producer', config).keyPrefix,
      ).toBeUndefined();
      expect(
        buildRedisConnectionOptions('queue-worker', config).keyPrefix,
      ).toBeUndefined();
    });
  });

  describe('queue-producer (outbox dispatcher)', () => {
    const options = buildRedisConnectionOptions('queue-producer', config);

    it('carries no ioredis key prefix', () => {
      expect(options.keyPrefix).toBeUndefined();
    });

    it('keeps a finite per-command retry budget so publishing can fail', () => {
      expect(options.maxRetriesPerRequest).toBe(2);
      expect(options.maxRetriesPerRequest).not.toBeNull();
      expect(options.commandTimeout).toBe(2_000);
    });

    it('buffers while reconnecting, unlike the request-facing role', () => {
      expect(options.enableOfflineQueue).toBe(true);
    });
  });

  describe('queue-worker (BullMQ blocking consumer)', () => {
    const options = buildRedisConnectionOptions('queue-worker', config);

    it('carries no ioredis key prefix', () => {
      expect(options.keyPrefix).toBeUndefined();
    });

    it('retries indefinitely, as BullMQ requires of a blocking connection', () => {
      expect(options.maxRetriesPerRequest).toBeNull();
    });

    it('sets no command timeout, which would abort its long polls', () => {
      expect(options.commandTimeout).toBeUndefined();
    });
  });

  it('propagates a changed retry budget to the finite roles only', () => {
    const tightened = { ...config, maxRetriesPerRequest: 1 };

    expect(
      buildRedisConnectionOptions('general', tightened).maxRetriesPerRequest,
    ).toBe(1);
    expect(
      buildRedisConnectionOptions('queue-producer', tightened)
        .maxRetriesPerRequest,
    ).toBe(1);
    expect(
      buildRedisConnectionOptions('queue-worker', tightened)
        .maxRetriesPerRequest,
    ).toBeNull();
  });
});

describe('RedisService (Redis unreachable)', () => {
  const unreachable = {
    url: 'redis://127.0.0.1:9',
    keyPrefix: 'test:',
    connectTimeoutMs: 150,
    commandTimeoutMs: 150,
    maxRetriesPerRequest: 1,
  };

  const info = jest.fn();
  const warn = jest.fn();
  const logger = { info, warn, error: jest.fn() } as unknown as PinoLogger;

  let service: RedisService | undefined;

  const create = () => {
    service = new RedisService(unreachable, logger);
    return service;
  };

  const eventually = async (
    condition: () => boolean,
    timeoutMs = 3_000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;

    while (!condition() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  beforeEach(() => {
    info.mockClear();
    warn.mockClear();
  });

  afterEach(async () => {
    await service?.onApplicationShutdown();
    service = undefined;
  });

  it('constructs without connecting, throwing, or blocking', () => {
    expect(() => create()).not.toThrow();
  });

  it('reports the connection as not ready', () => {
    const redis = create();

    expect(redis.isReady).toBe(false);
    expect(redis.hasEverConnected).toBe(false);
  });

  it('probes down rather than rejecting', async () => {
    await expect(create().probe()).resolves.toEqual({ status: 'down' });
  });

  it('probes within its own timeout instead of waiting out the outage', async () => {
    const redis = create();
    const startedAt = Date.now();

    await redis.probe();

    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it('absorbs connection errors instead of letting them go unhandled', async () => {
    create();

    await eventually(() => warn.mock.calls.length > 0);

    expect(warn).toHaveBeenCalled();
  });

  it('shuts down cleanly even though quit cannot succeed', async () => {
    const redis = create();

    await expect(redis.onApplicationShutdown()).resolves.toBeUndefined();
  });

  it('is safe to shut down twice', async () => {
    const redis = create();

    await redis.onApplicationShutdown();

    await expect(redis.onApplicationShutdown()).resolves.toBeUndefined();
  });
});
