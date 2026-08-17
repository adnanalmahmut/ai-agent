import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';

import { PrismaService } from '../src/database';
import { createHarness, type Harness } from './support/auth-harness';

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

      expect(JSON.stringify(response.body)).not.toContain('Connection terminated unexpectedly');
      querySpy.mockRestore();
    });
  });
});
