import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import request from 'supertest';

import {
  as,
  createHarness,
  createUser,
  type Harness,
  type TestUser,
} from '../../support/auth-harness';

describe('single-origin deployment (e2e)', () => {
  let harness: Harness;
  let user: TestUser;

  beforeAll(async () => {
    harness = await createHarness({ globalPrefix: 'api' });
    user = await createUser(harness);
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  describe('Better Auth keeps its own mount point', () => {
    it('still answers at /api/auth', async () => {
      const response = await as(harness, user).get(
        '/api/auth/organization/list',
      );

      expect(response.status).toBe(200);
    });

    it('is not moved to the doubly-prefixed path', async () => {
      await as(harness, user)
        .get('/api/api/auth/organization/list')
        .expect(404);
    });
  });

  describe('application routes move under the prefix', () => {
    it('serves the archived-organizations read at /api/organizations', async () => {
      const response = await as(harness, user).get(
        '/api/organizations/archived',
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('no longer answers at the unprefixed path', async () => {
      await as(harness, user).get('/organizations/archived').expect(404);
    });

    it('is still behind the global guard', async () => {
      await request(harness.server)
        .get('/api/organizations/archived')
        .expect(401);
    });
  });
});
