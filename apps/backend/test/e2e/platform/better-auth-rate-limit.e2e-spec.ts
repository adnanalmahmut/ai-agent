import { afterAll, beforeAll, describe, it } from '@jest/globals';
import request from 'supertest';

import { createHarness, type Harness } from '../../support/auth-harness';

describe('Better Auth native rate limiting', () => {
  let harness: Harness;
  const previous = process.env.BETTER_AUTH_RATE_LIMIT_ENABLED;

  beforeAll(async () => {
    process.env.BETTER_AUTH_RATE_LIMIT_ENABLED = 'true';
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
    if (previous === undefined)
      delete process.env.BETTER_AUTH_RATE_LIMIT_ENABLED;
    else process.env.BETTER_AUTH_RATE_LIMIT_ENABLED = previous;
  });

  it('allows five sign-ins per window and rejects the next attempt', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(harness.server)
        .post('/api/auth/sign-in/email')
        .send({ email: 'missing@example.test', password: 'wrong-password' })
        .expect(401);
    }
    await request(harness.server)
      .post('/api/auth/sign-in/email')
      .send({ email: 'missing@example.test', password: 'wrong-password' })
      .expect(429);
  });

  it('allows five sign-ups per window and rejects the next attempt', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(harness.server)
        .post('/api/auth/sign-up/email')
        .send({
          email: `limited-signup-${attempt}@example.test`,
          password: 'safe-password-01',
          name: 'Limited User',
        })
        .expect(200);
    }
    await request(harness.server)
      .post('/api/auth/sign-up/email')
      .send({
        email: 'limited-signup-final@example.test',
        password: 'safe-password-01',
        name: 'Limited User',
      })
      .expect(429);
  });

  it('allows three password-reset requests and rejects the next one', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await request(harness.server)
        .post('/api/auth/request-password-reset')
        .send({ email: `reset-${attempt}@example.test` })
        .expect(200);
    }
    await request(harness.server)
      .post('/api/auth/request-password-reset')
      .send({ email: 'reset-final@example.test' })
      .expect(429);
  });
});
