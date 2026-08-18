import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { PrismaService } from '../../database';
import type { RedisProbe, RedisService } from '../../infrastructure/redis';
import { ProcessReadiness } from '../lifecycle';
import { HealthService } from './health.service';

/**
 * Which dependency is allowed to take the service out of rotation.
 *
 * That question has a different answer for each dependency, and getting it
 * wrong is expensive in both directions: too strict and a Redis blip removes a
 * service that is still accepting work; too lax and traffic keeps arriving at a
 * process that cannot serve it.
 */
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

    /**
     * The property that makes liveness safe to wire to a restart policy. A
     * liveness probe that consulted a dependency would turn one database outage
     * into a restart loop across every replica, and they would come back to find
     * the database still down.
     */
    it('consults no dependency at all', () => {
      health.getLiveness();

      expect(queryRaw).not.toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalled();
    });

    it('reports ok even while draining', () => {
      readiness.markDraining();

      // Draining is not wedged. Restarting here would abandon the requests the
      // process is in the middle of finishing.
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

    /**
     * PostgreSQL is the system of record and every request path touches it, so
     * it is the one dependency whose loss means "send traffic elsewhere".
     */
    it('is not ready when PostgreSQL is unreachable', async () => {
      queryRaw.mockRejectedValue(new Error('connection terminated'));

      await expect(health.getReadiness()).resolves.toMatchObject({
        status: 'error',
        dependencies: { postgres: { status: 'down' } },
      });
    });

    /**
     * The transactional outbox, visible at the probe. Accepting asynchronous
     * work is one PostgreSQL transaction and no queue connection, so an
     * unreachable Redis delays execution rather than refusing work — and
     * answering 503 would remove a service that is still doing its job.
     */
    it('stays ready when Redis is unreachable', async () => {
      probe.mockResolvedValue({ status: 'down' });

      await expect(health.getReadiness()).resolves.toMatchObject({
        status: 'ready',
        dependencies: {
          postgres: { status: 'up' },
          // Describes this service's ability, which is reduced, not lost.
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

    /**
     * The input no dependency check can supply: the process reporting a decision
     * about itself. Checked first and alone — a draining instance should leave
     * rotation as promptly as possible, and nothing a healthy database could say
     * would change the answer.
     */
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

    /**
     * A probe that runs every few seconds on every replica must not call a paid
     * external API. It would be a standing bill and a standing outage risk, and
     * a slow provider says nothing about whether this process can accept a
     * request.
     */
    it('probes exactly two dependencies, and no provider', async () => {
      await health.getReadiness();

      expect(queryRaw).toHaveBeenCalledTimes(1);
      expect(probe).toHaveBeenCalledTimes(1);
    });

    /**
     * Concurrently, so the probe's latency is the slower dependency rather than
     * their sum. A readiness endpoint that takes longer than the probe timeout
     * is failing the probe, whatever it would eventually have said.
     */
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

      // Redis was asked without waiting for PostgreSQL to answer.
      expect(probe).toHaveBeenCalled();

      resolvePostgres?.();
      await pending;
    });
  });
});
