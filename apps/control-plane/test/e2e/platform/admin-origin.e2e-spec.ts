import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import request from 'supertest';

import {
  cookieOf,
  createHarness,
  createUser,
  type Harness,
  type TestUser,
} from '../../support/auth-harness';

/**
 * A real sign-in from the administrative surface.
 *
 * `apps/admin` has no accounts of its own: the browser posts same-origin to
 * its own `/api/auth/*`, which forwards here with the origin the browser
 * reported. So Better Auth sees the admin origin, and everything about
 * administrative login depends on that origin being trusted and on the
 * session cookie it issues being usable afterwards.
 *
 * This is the half that needs a real database and a real Better Auth: the
 * sign-in, the cookie and what `get-session` then says about the principal.
 * What the admin workspace tests on top of it is that its proxy forwards this
 * faithfully and that its gate reads these exact payloads as admit or refuse.
 */

// The origin a browser on the administrative shell reports. Asserted against
// configuration rather than assumed, so a missing entry says so instead of
// surfacing as a puzzling 403.
const ADMIN_BROWSER_ORIGIN = 'http://localhost:3003';

/** Every `Set-Cookie` the response carries, however supertest typed it. */
const cookiesOf = (response: {
  headers: Record<string, unknown>;
}): string[] => {
  const header = response.headers['set-cookie'];

  if (Array.isArray(header)) return header as string[];

  return typeof header === 'string' ? [header] : [];
};

const configuredOrigins = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

if (!configuredOrigins.includes(ADMIN_BROWSER_ORIGIN)) {
  throw new Error(
    `${ADMIN_BROWSER_ORIGIN} is not in BETTER_AUTH_TRUSTED_ORIGINS ` +
      `(${configuredOrigins.join(', ') || 'empty'}). The administrative shell ` +
      `signs in from that origin, so the two settings have to agree.`,
  );
}

describe('administrative sign-in from the admin origin', () => {
  let harness: Harness;
  let staff: TestUser;
  let ordinary: TestUser;

  const signInFrom = (origin: string | null, user: TestUser) => {
    const pending = request(harness.server).post('/api/auth/sign-in/email');

    return (origin === null ? pending : pending.set('Origin', origin)).send({
      email: user.email,
      password: user.password,
    });
  };

  const sessionWith = (cookie: string) =>
    request(harness.server)
      .get('/api/auth/get-session')
      .set('Origin', ADMIN_BROWSER_ORIGIN)
      .set('Cookie', cookie);

  beforeAll(async () => {
    harness = await createHarness();
    // `admin` holds platform-wide actions in the shared policy and is what the
    // admin shell admits; `user` holds none and is what it refuses.
    staff = await createUser(harness, { role: 'admin', signIn: false });
    ordinary = await createUser(harness, { signIn: false });
  }, 60_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('accepts a staff sign-in and issues a session cookie', async () => {
    const response = await signInFrom(ADMIN_BROWSER_ORIGIN, staff);

    expect(response.status).toBe(200);
    expect(cookieOf(response)).toContain('__Host-session=');
  });

  it('issues it host-only, which is what the same-origin proxy is for', async () => {
    const response = await signInFrom(ADMIN_BROWSER_ORIGIN, staff);
    const issued = cookiesOf(response).join('\n');

    // The `__Host-` prefix is a browser-enforced contract: the cookie must be
    // `Secure`, must be `Path=/`, and must carry no `Domain` — so it belongs
    // to exactly the origin that set it and cannot be shared across hosts.
    // A cross-origin sign-in could therefore never leave the admin surface
    // holding a session, which is why its browser posts same-origin and the
    // admin process forwards.
    expect(issued).toContain('__Host-session=');
    expect(issued).toContain('Path=/');
    expect(issued).toContain('Secure');
    expect(issued).not.toContain('Domain=');
  });

  it('accepts the cookie it issued and names the principal', async () => {
    const cookie = cookieOf(await signInFrom(ADMIN_BROWSER_ORIGIN, staff));

    const response = await sessionWith(cookie);

    expect(response.status).toBe(200);
    // The two fields the administrative gate reads, and nothing about this
    // response is specific to the admin surface: it is the same session.
    expect(response.body).toMatchObject({
      user: { id: staff.id, email: staff.email, role: 'admin' },
    });
  });

  it('reports an ordinary account as an ordinary account', async () => {
    const cookie = cookieOf(await signInFrom(ADMIN_BROWSER_ORIGIN, ordinary));

    const response = await sessionWith(cookie);

    expect(response.status).toBe(200);
    // `user` is the role every account gets, and the shared policy grants it
    // no platform-wide action. The gate refuses this session; the refusal is
    // a decision about what this payload means, not about the sign-in.
    expect(response.body.user.id).toBe(ordinary.id);
    expect(response.body.user.role).toBe('user');
  });

  it('still records a session for the account that signed in', async () => {
    const before = await harness.prisma.session.count({
      where: { userId: staff.id },
    });

    await signInFrom(ADMIN_BROWSER_ORIGIN, staff);

    expect(
      await harness.prisma.session.count({ where: { userId: staff.id } }),
    ).toBeGreaterThan(before);
  });

  describe('the allowlist grew by one origin and not by a policy', () => {
    // Adding the admin origin must not be the same thing as loosening the
    // check. Each of these looks like the admin origin without being it.
    it.each([
      ['a plainly foreign origin', 'https://attacker.example'],
      [
        'a host that only ends with it',
        'http://localhost:3003.attacker.example',
      ],
      [
        'userinfo hiding the real host',
        'http://localhost:3003@attacker.example',
      ],
      ['the same host on another scheme', 'https://localhost:3003'],
      ['the same host on another port', 'http://localhost:3004'],
    ])('refuses a sign-in from %s', async (_label, origin) => {
      const before = await harness.prisma.session.count({
        where: { userId: staff.id },
      });

      const response = await signInFrom(origin, staff);

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: 'INVALID_ORIGIN' });
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(
        await harness.prisma.session.count({ where: { userId: staff.id } }),
      ).toBe(before);
    });
  });
});
