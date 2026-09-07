import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import request from 'supertest';

import {
  createHarness,
  createUser,
  trustedBrowserOrigin,
  type Harness,
  type TestUser,
} from '../../support/auth-harness';

/**
 * Which origin a browser is on is not a permission.
 *
 * This is the invariant the administrative split rests on. Once account and
 * configuration screens move to their own surface, the tempting shortcut is to
 * let the surface stand for the authority — trust the admin hostname, trust
 * the admin `Origin`, trust that the request came from a page only staff can
 * load. Every one of those is a header, and a header is written by the caller.
 *
 * So the tests below take an ordinary customer with a perfectly valid session
 * and let them claim, as loudly as HTTP allows, to be on the administrative
 * surface. The answer has to be the same refusal every time, from the
 * authorization policy, on the strength of who they are.
 */

const ADMIN_LOOKALIKE = 'https://admin.example.com';

type Operation = {
  readonly label: string;
  readonly method: 'get' | 'post' | 'put' | 'del';
  readonly path: string;
  readonly body?: unknown;
};

/**
 * One representative operation per administrative capability the policy
 * grants: reading platform configuration, writing it, writing a managed
 * credential, reading the administrative audit trail, and the account
 * administration Better Auth owns. Exhaustive route coverage per role already
 * exists in `features/control-plane.e2e-spec.ts` and `admin-rbac.e2e-spec.ts`;
 * what is new here is the claim being made while asking.
 */
const ADMINISTRATIVE: readonly Operation[] = [
  {
    label: 'read platform configuration',
    method: 'get',
    path: '/platform/control-plane/settings',
  },
  {
    label: 'write platform configuration',
    method: 'put',
    path: '/platform/control-plane/settings/agents.max_concurrent_runs_per_organization',
    body: { value: 5 },
  },
  {
    label: 'read feature flags',
    method: 'get',
    path: '/platform/control-plane/feature-flags',
  },
  {
    label: 'write a managed credential',
    method: 'put',
    path: '/platform/control-plane/secrets/openai.api_key',
    body: { value: 'sk-test-only-not-a-real-key' },
  },
  {
    label: 'read the administrative audit trail',
    method: 'get',
    path: '/platform/control-plane/audit',
  },
  {
    label: 'list every account on the installation',
    method: 'get',
    path: '/api/auth/admin/list-users?limit=1',
  },
];

/** `it.each` widens a mixed tuple unless the table's type is stated. */
const CASES: readonly [string, Operation][] = ADMINISTRATIVE.map(
  (operation) => [operation.label, operation],
);

describe('an origin is not an authorization', () => {
  let harness: Harness;
  let customer: TestUser;
  let staff: TestUser;

  /**
   * Everything a request can say about where it came from, all of it hostile.
   * `Host` and `X-Forwarded-Host` are what a reverse proxy would set;
   * `Origin` and `Referer` are what a browser would send.
   */
  const claimingAdmin = (operation: Operation) => {
    const pending =
      operation.method === 'get'
        ? request(harness.server).get(operation.path)
        : operation.method === 'del'
          ? request(harness.server).delete(operation.path)
          : operation.method === 'put'
            ? request(harness.server).put(operation.path)
            : request(harness.server).post(operation.path);

    return pending
      .set('Cookie', customer.cookie)
      .set('Host', 'admin.example.com')
      .set('X-Forwarded-Host', 'admin.example.com')
      .set('X-Forwarded-Proto', 'https')
      .set('Origin', ADMIN_LOOKALIKE)
      .set('Referer', `${ADMIN_LOOKALIKE}/en/users`)
      .send(operation.body ?? undefined);
  };

  const asCustomer = (operation: Operation) => {
    const pending =
      operation.method === 'get'
        ? request(harness.server).get(operation.path)
        : operation.method === 'del'
          ? request(harness.server).delete(operation.path)
          : operation.method === 'put'
            ? request(harness.server).put(operation.path)
            : request(harness.server).post(operation.path);

    return pending
      .set('Cookie', customer.cookie)
      .set('Origin', trustedBrowserOrigin)
      .send(operation.body ?? undefined);
  };

  // The positive control below writes a real setting and a real credential,
  // and these tables are global to the installation rather than scoped to a
  // tenant. The suite therefore has to leave them as it found them: the
  // rotation suite seeds its own row at the same managed-secret key, and one
  // left behind here is a unique-constraint failure over there. Same helper
  // and same table list as `features/control-plane.e2e-spec.ts`.
  const cleanControlPlane = async () => {
    await harness.prisma.featureFlagOrganizationOverride.deleteMany();
    await harness.prisma.featureFlagPlatformOverride.deleteMany();
    await harness.prisma.runtimeSetting.deleteMany();
    await harness.prisma.managedSecret.deleteMany();
  };

  beforeAll(async () => {
    harness = await createHarness();
    // An ordinary account: the default `user` role, which the shared policy
    // grants no platform-wide action at all.
    customer = await createUser(harness);
    // The positive control. Without it a mistyped path would answer 404 and
    // read as a refusal, which is how a test like this quietly stops testing.
    staff = await createUser(harness, { role: 'super_admin' });

    await cleanControlPlane();
  }, 60_000);

  afterAll(async () => {
    await cleanControlPlane();
    await harness?.close();
  });

  it.each(CASES)(
    'is a route the policy really does grant to staff: %s',
    async (_label, operation) => {
      const pending =
        operation.method === 'get'
          ? request(harness.server).get(operation.path)
          : operation.method === 'put'
            ? request(harness.server).put(operation.path)
            : request(harness.server).post(operation.path);

      const response = await pending
        .set('Cookie', staff.cookie)
        .set('Origin', trustedBrowserOrigin)
        .send(operation.body ?? undefined);

      expect(response.status).toBeLessThan(400);
    },
  );

  it.each(CASES)(
    'refuses to let a customer %s by claiming the admin origin',
    async (_label, operation) => {
      const claimed = await claimingAdmin(operation);
      const plain = await asCustomer(operation);

      // Not merely refused — refused identically. If the headers changed
      // anything at all, they are an input to the decision.
      expect(claimed.status).toBe(plain.status);
      expect(claimed.status).toBe(403);
    },
  );

  it('leaves the platform configuration untouched by the attempt', async () => {
    // Compared against what is there rather than against zero: the positive
    // control above legitimately wrote a setting and a credential, and
    // asserting an empty table would only prove the fixture order.
    const stored = () =>
      Promise.all([
        harness.prisma.runtimeSetting.findMany({
          select: { key: true, value: true },
          orderBy: { key: 'asc' },
        }),
        harness.prisma.managedSecret.findMany({
          select: { key: true, updatedAt: true },
          orderBy: { key: 'asc' },
        }),
      ]);

    const before = await stored();

    for (const operation of ADMINISTRATIVE) {
      await claimingAdmin(operation);
    }

    // A refusal that still wrote the row would be no refusal.
    expect(await stored()).toEqual(before);
  });

  it('does not accept a forwarded host as the reason to answer differently', async () => {
    // The one header a deployment does legitimately trust — and only from its
    // own proxy, for the client address. It is not an identity claim.
    const response = await request(harness.server)
      .get('/platform/control-plane/settings')
      .set('Cookie', customer.cookie)
      .set('X-Forwarded-Host', 'admin.internal')
      .set('X-Real-IP', '10.0.0.1')
      .set('X-Forwarded-For', '10.0.0.1');

    expect(response.status).toBe(403);
  });

  it('refuses an anonymous caller who claims the admin origin just as flatly', async () => {
    const response = await request(harness.server)
      .get('/platform/control-plane/settings')
      .set('Host', 'admin.example.com')
      .set('Origin', ADMIN_LOOKALIKE);

    // 401 rather than 403: nobody is asking, so there is nobody to refuse.
    expect(response.status).toBe(401);
  });
});

describe('the session cookie belongs to one host', () => {
  let harness: Harness;
  let user: TestUser;

  const cookiesFrom = (headers: Record<string, unknown>): string[] => {
    const header = headers['set-cookie'];

    if (Array.isArray(header)) return header as string[];

    return typeof header === 'string' ? [header] : [];
  };

  beforeAll(async () => {
    harness = await createHarness();
    user = await createUser(harness, { signIn: false });
  }, 60_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('is issued host-only, with no Domain to widen it', async () => {
    const response = await request(harness.server)
      .post('/api/auth/sign-in/email')
      .set('Origin', trustedBrowserOrigin)
      .send({ email: user.email, password: user.password });

    expect(response.status).toBe(200);

    const session = cookiesFrom(response.headers).find((cookie) =>
      cookie.startsWith('__Host-session='),
    );

    expect(session).toBeDefined();
    // `__Host-` is enforced by the browser, not by us: it requires `Secure`,
    // requires `Path=/`, and forbids `Domain`. Together those make the cookie
    // the property of exactly the origin that set it, which is what keeps the
    // customer application's session and the administrative one separate
    // without any coordination between them.
    expect(session).toContain('Secure');
    expect(session).toContain('Path=/');
    expect(session).toContain('HttpOnly');
    expect(session).not.toMatch(/Domain=/i);
  });

  it('sets no cookie that widens or cross-sites itself', async () => {
    const response = await request(harness.server)
      .post('/api/auth/sign-in/email')
      .set('Origin', trustedBrowserOrigin)
      .send({ email: user.email, password: user.password });

    for (const cookie of cookiesFrom(response.headers)) {
      // A `Domain` attribute would share the session across every host under
      // it; `SameSite=None` would let any site send it. Neither is something
      // a same-origin design needs, and both are how a convenient
      // cross-subdomain session turns into a cross-subdomain compromise.
      expect(cookie).not.toMatch(/Domain=/i);
      expect(cookie).not.toMatch(/SameSite=None/i);
    }
  });

  it('signs out by clearing the same host-only cookie', async () => {
    const signIn = await request(harness.server)
      .post('/api/auth/sign-in/email')
      .set('Origin', trustedBrowserOrigin)
      .send({ email: user.email, password: user.password });

    const response = await request(harness.server)
      .post('/api/auth/sign-out')
      .set('Origin', trustedBrowserOrigin)
      .set(
        'Cookie',
        cookiesFrom(signIn.headers)
          .map((cookie) => cookie.split(';')[0])
          .join('; '),
      )
      .send({});

    expect(response.status).toBe(200);

    for (const cookie of cookiesFrom(response.headers)) {
      // A clearing cookie that carried a `Domain` would fail to clear the
      // host-only one it was meant to remove.
      expect(cookie).not.toMatch(/Domain=/i);
    }
  });
});
