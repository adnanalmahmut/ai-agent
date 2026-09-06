import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import request from 'supertest';

import {
  as,
  createHarness,
  createUser,
  trustedBrowserOrigin,
  type Harness,
  type TestUser,
} from '../../support/auth-harness';

// Better Auth decides whether to run its origin and CSRF checks from
// `advanced.disableOriginCheck`, and falls back to `isTest() ? true : false`
// when the option is absent. The application pins the option to `false`, so the
// checks below run under `NODE_ENV=test` exactly as they do in production.
// Without that pin every assertion here would pass vacuously, which is what
// makes this file the regression test for the pin itself.
describe('Better Auth origin and CSRF protection', () => {
  let harness: Harness;
  let user: TestUser;

  const preferredLanguageOf = async (id: string) =>
    (
      await harness.prisma.user.findUnique({
        where: { id },
        select: { preferredLanguage: true },
      })
    )?.preferredLanguage ?? null;

  // A state-changing, cookie-authenticated Better Auth route whose effect is
  // one readable column, so a refusal can be shown to have changed nothing.
  const updateLanguage = (origin: string | null) => {
    const pending = request(harness.server)
      .post('/api/auth/update-user')
      .set('Cookie', user.cookie);

    return (origin === null ? pending : pending.set('Origin', origin)).send({
      preferredLanguage: 'ar',
    });
  };

  beforeAll(async () => {
    harness = await createHarness();
    user = await createUser(harness);
  }, 60_000);

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.prisma.user.update({
      where: { id: user.id },
      data: { preferredLanguage: null },
    });
  });

  describe('a request from the trusted platform origin', () => {
    it('is carried out', async () => {
      const response = await updateLanguage(trustedBrowserOrigin);

      expect(response.status).toBe(200);
      expect(await preferredLanguageOf(user.id)).toBe('ar');
    });

    it('is what the shared harness sends on behalf of a signed-in user', async () => {
      const response = await as(harness, user).post('/api/auth/update-user', {
        preferredLanguage: 'ar',
      });

      expect(response.status).toBe(200);
    });
  });

  describe('a request from an origin outside the trusted list', () => {
    // Each shape is a different way of looking like the trusted origin without
    // being it. Better Auth compares parsed origins against `trustedOrigins`;
    // nothing here relies on prefix or suffix matching of our own.
    const REFUSED: readonly [string, string][] = [
      ['a plainly foreign origin', 'https://attacker.example'],
      [
        'a host that only ends with the trusted one',
        'http://localhost:3001.attacker.example',
      ],
      [
        'userinfo hiding the real host',
        'http://localhost:3001@attacker.example',
      ],
      ['the trusted host on another scheme', 'https://localhost:3001'],
      ['the trusted host on another port', 'http://localhost:4444'],
    ];

    it.each(REFUSED)('refuses %s', async (_label, origin) => {
      const response = await updateLanguage(origin);

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: 'INVALID_ORIGIN' });

      // Refused before the mutation, not after it.
      expect(await preferredLanguageOf(user.id)).toBeNull();
    });

    it('refuses a sign-in and starts no session', async () => {
      const before = await harness.prisma.session.count({
        where: { userId: user.id },
      });

      const response = await request(harness.server)
        .post('/api/auth/sign-in/email')
        .set('Origin', 'https://attacker.example')
        .send({ email: user.email, password: user.password });

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: 'INVALID_ORIGIN' });
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(
        await harness.prisma.session.count({ where: { userId: user.id } }),
      ).toBe(before);
    });
  });

  describe('a cookie-carrying request with no usable Origin', () => {
    it.each([
      ['no Origin header at all', null],
      ['a literal null Origin', 'null'],
    ])('refuses %s', async (_label, origin) => {
      const response = await updateLanguage(origin);

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: 'MISSING_OR_NULL_ORIGIN' });
      expect(await preferredLanguageOf(user.id)).toBeNull();
    });
  });

  // The first of the two independent layers guarding security mail. The second
  // — the server-decided destination in `auth-mail.ts` — is proven directly
  // against the callbacks in `test/unit/infrastructure/auth/auth-mail.spec.ts`,
  // because with this layer on, a foreign destination never reaches them.
  describe('security mail refuses a destination outside the trusted list', () => {
    it('refuses a foreign redirectTo and sends nothing', async () => {
      harness.transport.reset();

      const response = await request(harness.server)
        .post('/api/auth/request-password-reset')
        .send({
          email: user.email,
          redirectTo: 'https://attacker.example/steal',
        });

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: 'INVALID_REDIRECT_URL' });

      await harness.transport.settle();
      expect(harness.transport.sent).toEqual([]);
    });

    it('refuses a foreign callbackURL on a resend and sends nothing', async () => {
      harness.transport.reset();

      const response = await request(harness.server)
        .post('/api/auth/send-verification-email')
        .send({
          email: user.email,
          callbackURL: 'https://attacker.example/steal',
        });

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: 'INVALID_CALLBACK_URL' });

      await harness.transport.settle();
      expect(harness.transport.sent).toEqual([]);
    });

    it('refuses a foreign callbackURL at sign-up, and creates no account', async () => {
      const email = `origin-signup-${Date.now()}@example.com`;
      harness.transport.reset();

      const response = await request(harness.server)
        .post('/api/auth/sign-up/email')
        .send({
          name: 'Origin Probe',
          email,
          password: 'harness-password-01',
          callbackURL: 'https://attacker.example/steal',
        });

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: 'INVALID_CALLBACK_URL' });

      await harness.transport.settle();
      expect(harness.transport.sent).toEqual([]);
      expect(
        await harness.prisma.user.findUnique({ where: { email } }),
      ).toBeNull();
    });
  });
});
