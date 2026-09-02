import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';

import { PrismaService } from '../../src/infrastructure/database';
import { ProcessReadiness } from '../../src/infrastructure/lifecycle';
import { RedisService } from '../../src/infrastructure/redis';
import { createHarness, type Harness } from '../support/auth-harness';

describe('Health checks (e2e)', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({ globalPrefix: 'api' });
  }, 120_000);

  afterAll(async () => {
    await harness.close();
  });

  describe('GET /api/health/live', () => {
    it('returns 200 OK without requiring authentication', async () => {
      const response = await request(harness.server)
        .get('/api/health/live')
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        data: {
          status: 'ok',
        },
      });
      expect(typeof response.body.data.timestamp).toBe('string');
    });

    /**
     * The property that makes liveness safe to wire to a restart policy.
     *
     * A liveness probe that consulted PostgreSQL would turn one database outage
     * into a restart loop across every replica — and they would come back to
     * find the database still down. Liveness answers "is this process wedged";
     * only readiness answers "can it serve".
     */
    it('stays 200 while every dependency is unreachable', async () => {
      const prisma = harness.app.get(PrismaService);
      const redis = harness.app.get(RedisService);

      const query = jest
        .spyOn(prisma, '$queryRaw')
        .mockRejectedValue(new Error('connection terminated'));
      const probe = jest
        .spyOn(redis, 'probe')
        .mockResolvedValue({ status: 'down' });

      await request(harness.server).get('/api/health/live').expect(200);

      query.mockRestore();
      probe.mockRestore();
    });
  });

  describe('GET /api/health/ready', () => {
    it('returns 200 OK when database is reachable', async () => {
      const response = await request(harness.server)
        .get('/api/health/ready')
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        data: {
          status: 'ready',
          dependencies: {
            postgres: {
              status: 'up',
            },
          },
        },
      });
      expect(typeof response.body.data.timestamp).toBe('string');
    });

    it('returns 503 SERVICE_UNAVAILABLE error envelope when database is down', async () => {
      const prisma = harness.app.get(PrismaService);
      const querySpy = jest
        .spyOn(prisma, '$queryRaw')
        .mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));

      const response = await request(harness.server)
        .get('/api/health/ready')
        .expect(503);

      expect(response.body).toMatchObject({
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: expect.any(String),
          details: {
            postgres: {
              status: 'down',
            },
          },
        },
        meta: {
          requestId: expect.any(String),
          timestamp: expect.any(String),
        },
      });

      expect(JSON.stringify(response.body)).not.toContain(
        'Connection terminated unexpectedly',
      );
      querySpy.mockRestore();
    });

    it('reports the queue capability as available when Redis answers', async () => {
      const response = await request(harness.server)
        .get('/api/health/ready')
        .expect(200);

      expect(response.body.data).toMatchObject({
        status: 'ready',
        dependencies: { redis: { status: 'up' } },
        capabilities: { queue: 'available' },
      });
    });

    /**
     * The whole point of the transactional outbox, visible at the probe.
     *
     * With Redis unreachable the service can still accept work: `POST` writes
     * the row and its outbox event in one PostgreSQL transaction, and the
     * request path opens no queue connection at all. Answering 503 here would
     * take a service that is still doing its job out of rotation, and the jobs
     * accumulating in the outbox would have nowhere to be accepted at all.
     */
    it('stays ready when Redis is unreachable, reporting the degradation', async () => {
      const redis = harness.app.get(RedisService);
      const probe = jest
        .spyOn(redis, 'probe')
        .mockResolvedValue({ status: 'down' });

      const response = await request(harness.server)
        .get('/api/health/ready')
        .expect(200);

      expect(response.body.data).toMatchObject({
        status: 'ready',
        dependencies: {
          postgres: { status: 'up' },
          // `degraded`, not `down`: the word describes this service's ability,
          // which is reduced rather than lost.
          redis: { status: 'degraded' },
        },
        capabilities: { queue: 'degraded' },
      });

      probe.mockRestore();
    });

    /**
     * PostgreSQL has no equivalent grace. It is the system of record, and every
     * request path either reads or writes it.
     */
    it('is not ready when PostgreSQL is down even if Redis is fine', async () => {
      const prisma = harness.app.get(PrismaService);
      const query = jest
        .spyOn(prisma, '$queryRaw')
        .mockRejectedValueOnce(new Error('connection terminated'));

      await request(harness.server).get('/api/health/ready').expect(503);

      query.mockRestore();
    });

    /**
     * The input no dependency check can supply: the process reporting a decision
     * about itself. Without it, a draining instance keeps advertising as healthy
     * until it stops answering, and the load balancer keeps sending it requests
     * that get cut off mid-flight.
     */
    it('fails while draining, whatever the dependencies say', async () => {
      const readiness = harness.app.get(ProcessReadiness);
      readiness.markDraining();

      try {
        const response = await request(harness.server)
          .get('/api/health/ready')
          .expect(503);

        expect(response.body.error.details).toEqual({
          process: { status: 'draining' },
        });

        // And liveness is unaffected: the process is draining, not wedged.
        // Restarting it here would abandon the requests it is finishing.
        await request(harness.server).get('/api/health/live').expect(200);
      } finally {
        // This harness is torn down after the suite, but the state is
        // deliberately one-way, so the instance is replaced rather than reset.
        await harness.close();
        harness = await createHarness({ globalPrefix: 'api' });
      }
    }, 120_000);
  });
});
