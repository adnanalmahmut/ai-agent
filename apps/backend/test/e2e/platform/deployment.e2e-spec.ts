import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import request from 'supertest';

import {
  as,
  createHarness,
  createUser,
  type Harness,
  type TestUser,
} from '../../support/auth-harness';

/**
 * The single-origin deployment, exercised.
 *
 * Production serves three applications from one host behind one reverse
 * proxy: `/` is the web application, `/platform/*` is the Platform, and
 * `/api/*` is this one. `main.ts` earns the third with a single
 * `setGlobalPrefix('api')`, and the whole arrangement rests on one
 * non-obvious property of that call — that Better Auth is *excluded* from it.
 *
 * The exclusion is not ours: `@thallesp/nestjs-better-auth` appends its base
 * path to the global-prefix exclude list when the module is constructed. That
 * is exactly the kind of behaviour a library upgrade can change silently,
 * turning every authentication request into a 404 in production and nowhere
 * else. So it is asserted rather than assumed.
 *
 * Every other suite boots without the prefix, which is why this is its own
 * file: it is the only place the production mount points are checked, and
 * running the other suites through it would only re-test routing they already
 * cover.
 */
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
      // The prefix moves routes. It must not move them out from behind the
      // guard on the way.
      await request(harness.server)
        .get('/api/organizations/archived')
        .expect(401);
    });
  });
});
