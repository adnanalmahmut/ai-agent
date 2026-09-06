import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { PrismaService } from '../../../../src/infrastructure/database';
import { ProcessReadiness } from '../../../../src/infrastructure/lifecycle';
import type {
  RedisProbe,
  RedisService,
} from '../../../../src/infrastructure/redis';
import { HealthService } from '../../../../src/infrastructure/health/health.service';

describe('HealthService', () => {
  const queryRaw = jest.fn<() => Promise<unknown>>();
  const probe = jest.fn<() => Promise<RedisProbe>>();

  const prisma = { $queryRaw: queryRaw } as unknown as PrismaService;
  const redis = { probe } as unknown as RedisService;

  let readiness: ProcessReadiness;
  let health: HealthService;

  beforeEach(() => {
    queryRaw.mockReset().mockResolvedValue([{ '?column?': 1 }]);
    probe.mockReset().mockResolvedValue({ status: 'up', latencyMs: 1 });

    readiness = new ProcessReadiness();
    readiness.markReady();
    health = new HealthService(prisma, redis, readiness);
  });

  describe('liveness', () => {
    it('reports ok', () => {
      expect(health.getLiveness()).toMatchObject({ status: 'ok' });
    });

    it('consults no dependency at all', () => {
      health.getLiveness();

      expect(queryRaw).not.toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalled();
    });

    it('reports ok even while draining', () => {
      readiness.markDraining();

      expect(health.getLiveness()).toMatchObject({ status: 'ok' });
    });
  });

  describe('readiness', () => {
    it('is ready when both dependencies answer', async () => {
      await expect(health.getReadiness()).resolves.toMatchObject({
        status: 'ready',
        dependencies: {
          postgres: { status: 'up' },
          redis: { status: 'up' },
        },
        capabilities: { queue: 'available' },
      });
    });

    it('is not ready when PostgreSQL is unreachable', async () => {
      queryRaw.mockRejectedValue(new Error('connection terminated'));

      await expect(health.getReadiness()).resolves.toMatchObject({
        status: 'error',
        dependencies: { postgres: { status: 'down' } },
      });
    });

    it('stays ready when Redis is unreachable', async () => {
      probe.mockResolvedValue({ status: 'down' });

      await expect(health.getReadiness()).resolves.toMatchObject({
        status: 'ready',
        dependencies: {
          postgres: { status: 'up' },
          redis: { status: 'degraded' },
        },
        capabilities: { queue: 'degraded' },
      });
    });

    it('reports both failures when neither dependency answers', async () => {
      queryRaw.mockRejectedValue(new Error('connection terminated'));
      probe.mockResolvedValue({ status: 'down' });

      await expect(health.getReadiness()).resolves.toMatchObject({
        status: 'error',
        dependencies: {
          postgres: { status: 'down' },
          redis: { status: 'degraded' },
        },
        capabilities: { queue: 'degraded' },
      });
    });

    it('fails while draining, without consulting anything', async () => {
      readiness.markDraining();

      await expect(health.getReadiness()).resolves.toEqual({
        status: 'error',
        timestamp: expect.any(String),
        dependencies: { process: { status: 'draining' } },
      });

      expect(queryRaw).not.toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalled();
    });

    it('probes exactly two dependencies, and no provider', async () => {
      await health.getReadiness();

      expect(queryRaw).toHaveBeenCalledTimes(1);
      expect(probe).toHaveBeenCalledTimes(1);
    });

    it('probes the dependencies concurrently', async () => {
      let resolvePostgres: (() => void) | undefined;
      queryRaw.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvePostgres = () => resolve([]);
          }),
      );

      const pending = health.getReadiness();
      await Promise.resolve();

      expect(probe).toHaveBeenCalled();

      resolvePostgres?.();
      await pending;
    });
  });
});
