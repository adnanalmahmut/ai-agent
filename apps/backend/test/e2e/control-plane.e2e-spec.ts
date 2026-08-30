import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from '@jest/globals';
import request from 'supertest';

import encryptionConfig from '../../src/config/encryption.config';
import { FEATURE_FLAG_KEYS } from '../../src/control-plane';
import { ControlPlaneController } from '../../src/control-plane/control-plane.controller';
import { ManagedSecretKeyring } from '../../src/control-plane/managed-secrets/managed-secret-keyring';
import {
  as,
  createHarness,
  createUser,
  errorBody,
  type Harness,
  type TestUser,
} from '../support/auth-harness';

/**
 * The operator surface, against the real application and the real database.
 *
 * Three things are only true end to end and are therefore asserted here rather
 * than in the service specs: that these routes are super-administrator
 * territory and stay that way, that one organization's override cannot be seen
 * by another, and that a credential posted through the HTTP surface does not
 * come back out of it.
 *
 * Authorization is asserted against a table of every route rather than a
 * sample, for the reason given on that block: these routes can switch a paid
 * subsystem on for every tenant at once, and the guard that goes missing is
 * always the one on the route nobody thought to probe.
 */

const BASE = '/platform/control-plane';

const FLAG = 'agents.enabled';
const SETTING = 'agents.max_concurrent_runs_per_organization';
const SECRET = 'openai.api_key';

/** Unmistakable, and searched for in the raw response bytes. */
const CANARY = 'sk-CANARY-do-not-log-0000000000';

type FlagState = {
  key: string;
  enabled: boolean;
  source: 'organization' | 'platform' | 'default';
  defaultEnabled: boolean;
  platformOverride: boolean | undefined;
  organizationOverride: boolean | undefined;
};

type SettingState = {
  key: string;
  value: unknown;
  isDefault: boolean;
  defaultValue: unknown;
};

type SecretState = {
  key: string;
  configured: boolean;
  usable: boolean;
  label: string | undefined;
};

const dataOf = <T>(body: unknown): T => (body as { data: T }).data;

/**
 * One row per route the controller declares.
 *
 * The authorization sweep below is only worth as much as this table is
 * complete, so `handler` is typed against the controller and checked against
 * its prototype: a route added without a row here fails a test rather than
 * quietly shipping unprobed. `path` is a function because the organization
 * identifiers only exist once `beforeAll` has run.
 */
type ControlPlaneRoute = {
  handler: keyof ControlPlaneController;
  label: string;
  method: 'get' | 'put' | 'del';
  path: () => string;
  body?: unknown;
};

const flagIn = (body: unknown, key: string): FlagState => {
  const found = dataOf<FlagState[]>(body).find((state) => state.key === key);
  if (!found) throw new Error(`no state for feature flag ${key}`);

  return found;
};

describe('Control plane (e2e)', () => {
  let harness: Harness;
  let plainUser: TestUser;
  let admin: TestUser;
  let superAdmin: TestUser;
  let owner: TestUser;
  let organizationA: string;
  let organizationB: string;

  const ROUTES: ControlPlaneRoute[] = [
    {
      handler: 'listFeatureFlags',
      label: 'GET feature-flags',
      method: 'get',
      path: () => `${BASE}/feature-flags`,
    },
    {
      handler: 'listFeatureFlagsForOrganization',
      label: 'GET feature-flags for one organization',
      method: 'get',
      path: () => `${BASE}/feature-flags/organizations/${organizationA}`,
    },
    {
      handler: 'setFeatureFlag',
      label: 'PUT feature-flag platform override',
      method: 'put',
      path: () => `${BASE}/feature-flags/${FLAG}`,
      body: { enabled: true },
    },
    {
      handler: 'clearFeatureFlag',
      label: 'DELETE feature-flag platform override',
      method: 'del',
      path: () => `${BASE}/feature-flags/${FLAG}`,
    },
    {
      handler: 'setOrganizationFeatureFlag',
      label: 'PUT feature-flag organization override',
      method: 'put',
      path: () =>
        `${BASE}/feature-flags/${FLAG}/organizations/${organizationA}`,
      body: { enabled: true },
    },
    {
      handler: 'clearOrganizationFeatureFlag',
      label: 'DELETE feature-flag organization override',
      method: 'del',
      path: () =>
        `${BASE}/feature-flags/${FLAG}/organizations/${organizationA}`,
    },
    {
      handler: 'listSettings',
      label: 'GET settings',
      method: 'get',
      path: () => `${BASE}/settings`,
    },
    {
      handler: 'setSetting',
      label: 'PUT setting',
      method: 'put',
      path: () => `${BASE}/settings/${SETTING}`,
      body: { value: 5 },
    },
    {
      handler: 'resetSetting',
      label: 'DELETE setting',
      method: 'del',
      path: () => `${BASE}/settings/${SETTING}`,
    },
    {
      handler: 'listSecrets',
      label: 'GET secrets',
      method: 'get',
      path: () => `${BASE}/secrets`,
    },
    {
      handler: 'listAudit',
      label: 'GET audit',
      method: 'get',
      path: () => `${BASE}/audit`,
    },
    {
      handler: 'setSecret',
      label: 'PUT secret',
      method: 'put',
      path: () => `${BASE}/secrets/${SECRET}`,
      body: { value: CANARY, label: 'authorization sweep' },
    },
    {
      handler: 'removeSecret',
      label: 'DELETE secret',
      method: 'del',
      path: () => `${BASE}/secrets/${SECRET}`,
    },
  ];

  /** Issues one route, signed in as `actor` or with no session at all. */
  const send = (route: ControlPlaneRoute, actor: TestUser | undefined) => {
    const client =
      actor === undefined
        ? {
            get: (path: string) => request(harness.server).get(path),
            put: (path: string, body?: unknown) =>
              request(harness.server)
                .put(path)
                .send(body ?? {}),
            del: (path: string) => request(harness.server).delete(path),
          }
        : as(harness, actor);

    if (route.method === 'get') return client.get(route.path());
    if (route.method === 'put') return client.put(route.path(), route.body);

    return client.del(route.path());
  };

  /**
   * Every route's status, labelled. Compared against a labelled expectation so
   * a leak names the route that leaked instead of reporting `403 !== 200`
   * somewhere in a loop. Sequential because these share a database.
   */
  const statusesFor = async (
    actor: TestUser | undefined,
  ): Promise<string[]> => {
    const observed: string[] = [];

    for (const route of ROUTES) {
      const response = await send(route, actor);
      observed.push(`${route.label}: ${response.status}`);
    }

    return observed;
  };

  const everyRoute = (status: number): string[] =>
    ROUTES.map((route) => `${route.label}: ${status}`);

  /** Every table the control plane owns, so "nothing was written" is total. */
  const storedRowCounts = async () => ({
    featureFlagPlatformOverride:
      await harness.prisma.featureFlagPlatformOverride.count(),
    featureFlagOrganizationOverride:
      await harness.prisma.featureFlagOrganizationOverride.count(),
    runtimeSetting: await harness.prisma.runtimeSetting.count(),
    managedSecret: await harness.prisma.managedSecret.count(),
  });

  const NO_ROWS = {
    featureFlagPlatformOverride: 0,
    featureFlagOrganizationOverride: 0,
    runtimeSetting: 0,
    managedSecret: 0,
  };

  const createOrganization = async (user: TestUser, name: string) => {
    const response = await as(harness, user).post(
      '/api/auth/organization/create',
      {
        name,
        slug: `${name.toLowerCase()}-${Date.now().toString(36)}-${Math.floor(
          Math.random() * 1e6,
        )}`,
      },
    );

    expect(response.status).toBe(200);
    return (response.body as { id: string }).id;
  };

  /**
   * Empties the four tables the control plane owns, so an interrupted run
   * cannot leave a flag switched on for the next suite.
   *
   * Deliberately unscoped rather than restricted to the code-owned registry
   * keys. Several assertions below are that a rejected write left *no* row
   * behind, and the row a defect would leave is precisely one whose key no
   * registry names — so a registry-scoped delete could never clear it, and one
   * escaped write would fail every later run until somebody truncated the
   * table by hand. Nothing outside these tables is touched.
   */
  const cleanControlPlane = async () => {
    await harness.prisma.featureFlagOrganizationOverride.deleteMany();
    await harness.prisma.featureFlagPlatformOverride.deleteMany();
    await harness.prisma.runtimeSetting.deleteMany();
    await harness.prisma.managedSecret.deleteMany();
  };

  beforeAll(async () => {
    harness = await createHarness();

    plainUser = await createUser(harness);
    admin = await createUser(harness, { role: 'admin' });
    superAdmin = await createUser(harness, { role: 'super_admin' });
    owner = await createUser(harness);

    organizationA = await createOrganization(owner, 'ControlPlaneA');
    organizationB = await createOrganization(owner, 'ControlPlaneB');

    await cleanControlPlane();
  }, 90_000);

  afterEach(async () => {
    await cleanControlPlane();
  });

  afterAll(async () => {
    await cleanControlPlane();
    await harness?.close();
  });

  /**
   * The whole surface, for every caller who must not reach it.
   *
   * Read and write are separate permissions and neither belongs to anyone but a
   * super administrator, so the unit of assertion is the route *table* rather
   * than a hand-picked sample. A sample is what lets a guard go missing from
   * the one route nobody thought to probe — a `DELETE` in particular, since the
   * removals are the routes a reviewer's eye skips and the ones that silently
   * revert an operator's configuration.
   *
   * `admin` is here deliberately. A plain user failing is unsurprising; the
   * boundary that actually moves under a careless edit to `permissions.ts` is
   * the one between `admin` and `super_admin`.
   *
   * The organization owner is here for the other reason: they own
   * `organizationA`, and half of these routes are addressed by that
   * organization's identifier. Owning the tenant a route names must not grant
   * the route — these are an operator's rollout controls, not a tenant's
   * settings page, and organization RBAC is a separate domain from platform
   * RBAC.
   */
  describe('authorization', () => {
    /**
     * Keeps the table honest. Without this, adding a route and forgetting to
     * list it would silently shrink every sweep below to the old surface.
     */
    it('probes every route the controller declares', () => {
      const declared = Object.getOwnPropertyNames(
        ControlPlaneController.prototype,
      ).filter((name) => name !== 'constructor');

      expect(ROUTES.map((route) => route.handler).sort()).toEqual(
        declared.sort(),
      );
    });

    it('lets a super administrator reach every route', async () => {
      expect(await statusesFor(superAdmin)).toEqual(everyRoute(200));
    });

    it.each([
      { caller: 'a platform user', of: () => plainUser },
      { caller: 'a platform admin', of: () => admin },
      { caller: 'an organization owner', of: () => owner },
    ])('refuses $caller on every route, read and write', async ({ of }) => {
      expect(await statusesFor(of())).toEqual(everyRoute(403));
    });

    it('refuses an anonymous caller on every route', async () => {
      expect(await statusesFor(undefined)).toEqual(everyRoute(401));
    });

    /**
     * A refused write must not be a write.
     *
     * Status codes alone cannot show this: a guard that ran after the handler,
     * or a handler that persisted before the guard's decision was applied,
     * would still answer 403. So the sweep is followed by a direct look at
     * every table the control plane owns.
     */
    it('writes nothing while refusing every unauthorized caller', async () => {
      for (const actor of [plainUser, admin, owner, undefined]) {
        await statusesFor(actor);
      }

      expect(await storedRowCounts()).toEqual(NO_ROWS);
    });
  });

  describe('feature flags', () => {
    it('lists every registered flag at its code default', async () => {
      const response = await as(harness, superAdmin)
        .get(`${BASE}/feature-flags`)
        .expect(200);

      const states = dataOf<FlagState[]>(response.body);

      expect(states.map((state) => state.key).sort()).toEqual(
        [...FEATURE_FLAG_KEYS].sort(),
      );
      for (const state of states) {
        expect(state.source).toBe('default');
        expect(state.enabled).toBe(state.defaultEnabled);
        expect(state).not.toHaveProperty('platformOverride');
      }
    });

    it('changes the resolved value when a platform override is set', async () => {
      const write = await as(harness, superAdmin)
        .put(`${BASE}/feature-flags/${FLAG}`, { enabled: true })
        .expect(200);

      expect(dataOf<FlagState>(write.body)).toMatchObject({
        key: FLAG,
        enabled: true,
        source: 'platform',
        platformOverride: true,
      });

      const read = await as(harness, superAdmin)
        .get(`${BASE}/feature-flags`)
        .expect(200);

      expect(flagIn(read.body, FLAG)).toMatchObject({
        enabled: true,
        source: 'platform',
      });
    });

    /**
     * Clearing is a distinct operation from pinning the default, and the
     * difference is visible in `source` even while the two agree on `enabled`.
     */
    it('returns to the code default when the override is cleared', async () => {
      await as(harness, superAdmin)
        .put(`${BASE}/feature-flags/${FLAG}`, { enabled: true })
        .expect(200);

      const cleared = await as(harness, superAdmin)
        .del(`${BASE}/feature-flags/${FLAG}`)
        .expect(200);

      // `undefined` fields do not survive JSON, so absence is the assertion:
      // no override tier is reported at all.
      expect(dataOf<FlagState>(cleared.body)).toMatchObject({
        enabled: false,
        source: 'default',
      });
      expect(dataOf<FlagState>(cleared.body)).not.toHaveProperty(
        'platformOverride',
      );
      expect(
        await harness.prisma.featureFlagPlatformOverride.findUnique({
          where: { key: FLAG },
        }),
      ).toBeNull();
    });

    it('rejects a body that is not a boolean flag state', async () => {
      await as(harness, superAdmin)
        .put(`${BASE}/feature-flags/${FLAG}`, { enabled: 'yes' })
        .expect(400);
    });
  });

  /**
   * Tenant isolation, stated as its own property rather than inferred from the
   * precedence tests.
   *
   * An override is a rollout tool, and a rollout that reached organizations it
   * was not aimed at would be indistinguishable from a platform switch — which
   * is exactly the mistake that makes a per-tenant flag worse than no flag.
   */
  describe('organization overrides', () => {
    it('changes one organization and leaves the other exactly as it was', async () => {
      await as(harness, superAdmin)
        .put(`${BASE}/feature-flags/${FLAG}/organizations/${organizationA}`, {
          enabled: true,
        })
        .expect(200);

      const forA = await as(harness, superAdmin)
        .get(`${BASE}/feature-flags/organizations/${organizationA}`)
        .expect(200);
      const forB = await as(harness, superAdmin)
        .get(`${BASE}/feature-flags/organizations/${organizationB}`)
        .expect(200);

      expect(flagIn(forA.body, FLAG)).toMatchObject({
        enabled: true,
        source: 'organization',
        organizationOverride: true,
      });
      expect(flagIn(forB.body, FLAG)).toMatchObject({
        enabled: false,
        source: 'default',
      });
      expect(flagIn(forB.body, FLAG)).not.toHaveProperty(
        'organizationOverride',
      );

      // And the platform view is untouched by either.
      expect(
        flagIn(
          (
            await as(harness, superAdmin)
              .get(`${BASE}/feature-flags`)
              .expect(200)
          ).body,
          FLAG,
        ),
      ).toMatchObject({ enabled: false, source: 'default' });
    });

    it('lets one organization opt out of a platform-wide switch', async () => {
      await as(harness, superAdmin)
        .put(`${BASE}/feature-flags/${FLAG}`, { enabled: true })
        .expect(200);
      await as(harness, superAdmin)
        .put(`${BASE}/feature-flags/${FLAG}/organizations/${organizationA}`, {
          enabled: false,
        })
        .expect(200);

      const forA = await as(harness, superAdmin)
        .get(`${BASE}/feature-flags/organizations/${organizationA}`)
        .expect(200);
      const forB = await as(harness, superAdmin)
        .get(`${BASE}/feature-flags/organizations/${organizationB}`)
        .expect(200);

      expect(flagIn(forA.body, FLAG)).toMatchObject({
        enabled: false,
        source: 'organization',
      });
      expect(flagIn(forB.body, FLAG)).toMatchObject({
        enabled: true,
        source: 'platform',
      });
    });

    it('removes only the targeted organization row when an override is cleared', async () => {
      for (const organizationId of [organizationA, organizationB]) {
        await as(harness, superAdmin)
          .put(
            `${BASE}/feature-flags/${FLAG}/organizations/${organizationId}`,
            {
              enabled: true,
            },
          )
          .expect(200);
      }

      await as(harness, superAdmin)
        .del(`${BASE}/feature-flags/${FLAG}/organizations/${organizationA}`)
        .expect(200);

      const remaining =
        await harness.prisma.featureFlagOrganizationOverride.findMany({
          where: { key: FLAG },
          select: { organizationId: true },
        });

      expect(remaining).toEqual([{ organizationId: organizationB }]);
    });
  });

  describe('runtime settings', () => {
    it('stores a value the registered schema accepts', async () => {
      const response = await as(harness, superAdmin)
        .put(`${BASE}/settings/${SETTING}`, { value: 25 })
        .expect(200);

      expect(dataOf<SettingState>(response.body)).toMatchObject({
        key: SETTING,
        value: 25,
        isDefault: false,
      });
    });

    /**
     * A bounded setting whose refusal said only "invalid" would leave an
     * operator guessing at the bound, so the schema's own messages are public.
     */
    it.each([
      { label: 'above the maximum', value: 5_000 },
      { label: 'below the minimum', value: 0 },
      { label: 'not an integer', value: 2.5 },
      { label: 'not a number', value: 'twelve' },
    ])('refuses a value $label with issue messages', async ({ value }) => {
      const response = await as(harness, superAdmin)
        .put(`${BASE}/settings/${SETTING}`, { value })
        .expect(400);

      const body = errorBody(response);
      const issues = (body.error?.details as { issues?: unknown })?.issues;

      expect(body.errorCode).toBe('VALIDATION_ERROR');
      expect(Array.isArray(issues)).toBe(true);
      expect((issues as string[]).length).toBeGreaterThan(0);
      expect(
        (issues as string[]).every((issue) => typeof issue === 'string'),
      ).toBe(true);
      expect(
        await harness.prisma.runtimeSetting.findUnique({
          where: { key: SETTING },
        }),
      ).toBeNull();
    });

    it('restores the code default by removing the row', async () => {
      await as(harness, superAdmin)
        .put(`${BASE}/settings/${SETTING}`, { value: 25 })
        .expect(200);

      const response = await as(harness, superAdmin)
        .del(`${BASE}/settings/${SETTING}`)
        .expect(200);

      expect(dataOf<SettingState>(response.body)).toMatchObject({
        isDefault: true,
      });
      expect(
        await harness.prisma.runtimeSetting.findUnique({
          where: { key: SETTING },
        }),
      ).toBeNull();
    });
  });

  /**
   * The credential surface, checked at the bytes.
   *
   * Asserting on the parsed body would miss a value that leaked through a field
   * nobody thought to look at, so the raw response text is searched as well.
   */
  describe('managed secrets', () => {
    const storeCanary = () =>
      as(harness, superAdmin)
        .put(`${BASE}/secrets/${SECRET}`, {
          value: CANARY,
          label: 'e2e canary',
        })
        .expect(200);

    it('acknowledges a stored credential with metadata and nothing else', async () => {
      const response = await storeCanary();

      expect(dataOf<SecretState>(response.body)).toEqual({
        key: SECRET,
        description: expect.any(String),
        configured: true,
        usable: true,
        label: 'e2e canary',
        algorithm: 'aes-256-gcm',
        keyVersion: expect.any(String),
        lastRotatedAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      expect(response.text).not.toContain(CANARY);
      expect(response.text).not.toContain('CANARY');
    });

    it('lists it as configured without a field that could hold the value', async () => {
      await storeCanary();

      const response = await as(harness, superAdmin)
        .get(`${BASE}/secrets`)
        .expect(200);

      const [state] = dataOf<SecretState[]>(response.body);

      expect(state).toMatchObject({ configured: true, usable: true });
      for (const forbidden of [
        'value',
        'ciphertext',
        'iv',
        'authTag',
        'plaintext',
        'keyFingerprint',
      ]) {
        expect(state).not.toHaveProperty(forbidden);
      }
      expect(response.text).not.toContain(CANARY);
      expect(response.text).not.toContain('CANARY');
    });

    /**
     * What is in the table, not just what comes back out of it. Encryption at
     * rest is the promise this model makes, and only a direct read can show
     * that the column holds ciphertext rather than the credential.
     */
    it('persists the credential encrypted, recoverable only with the master key', async () => {
      await storeCanary();

      const row = await harness.prisma.managedSecret.findUniqueOrThrow({
        where: { key: SECRET },
      });

      expect(Buffer.from(row.ciphertext).toString('latin1')).not.toContain(
        CANARY,
      );
      expect(Buffer.from(row.ciphertext).toString('utf8')).not.toContain(
        'CANARY',
      );
      expect(row.iv).toHaveLength(12);
      const keyring = new ManagedSecretKeyring(encryptionConfig());
      expect(keyring.open(SECRET, row)).toBe(CANARY);
    });

    it('rotates in place rather than accumulating rows', async () => {
      await storeCanary();
      const first = await harness.prisma.managedSecret.findUniqueOrThrow({
        where: { key: SECRET },
      });

      await storeCanary();
      const second = await harness.prisma.managedSecret.findUniqueOrThrow({
        where: { key: SECRET },
      });

      expect(await harness.prisma.managedSecret.count()).toBe(1);
      expect(Buffer.from(second.iv)).not.toEqual(Buffer.from(first.iv));
    });

    it('refuses a value the registry does not recognise as a credential', async () => {
      const response = await as(harness, superAdmin)
        .put(`${BASE}/secrets/${SECRET}`, { value: 'sk-CANARY-short' })
        .expect(400);

      expect(errorBody(response).errorCode).toBe('VALIDATION_ERROR');
      expect(response.text).not.toContain('CANARY');
      expect(await harness.prisma.managedSecret.count()).toBe(0);
    });

    it('removes the row and reports the slot as unconfigured', async () => {
      await storeCanary();

      const response = await as(harness, superAdmin)
        .del(`${BASE}/secrets/${SECRET}`)
        .expect(200);

      expect(dataOf<SecretState>(response.body)).toMatchObject({
        configured: false,
        usable: false,
      });
      expect(await harness.prisma.managedSecret.count()).toBe(0);
    });
  });

  /**
   * A key that is not in the code-owned registry is a 404 at the boundary, for
   * all three resources. The alternative — accepting the write — is a row
   * nothing reads and an operator who believes they configured something.
   */
  describe('unknown keys', () => {
    const unknown = 'definitely.not.a.registered.key';

    it.each([
      {
        resource: 'feature flag',
        path: `feature-flags/${unknown}`,
        body: { enabled: true },
      },
      {
        resource: 'runtime setting',
        path: `settings/${unknown}`,
        body: { value: 1 },
      },
      {
        resource: 'managed secret',
        path: `secrets/${unknown}`,
        body: { value: CANARY },
      },
    ])(
      'answers 404 when writing an unknown $resource, and stores nothing',
      async ({ path, body }) => {
        const response = await as(harness, superAdmin)
          .put(`${BASE}/${path}`, body)
          .expect(404);

        expect(errorBody(response).errorCode).toBe('NOT_FOUND');
        expect(response.text).not.toContain('CANARY');
        /**
         * The status is only half of the contract. A key checked after the
         * write would answer 404 and still leave a row behind — one that no
         * registry names, so no read surface lists it and no operator can
         * clear it through the control plane.
         */
        expect(await storedRowCounts()).toEqual(NO_ROWS);
      },
    );

    it.each([
      { resource: 'feature flag', path: `feature-flags/${unknown}` },
      { resource: 'runtime setting', path: `settings/${unknown}` },
      { resource: 'managed secret', path: `secrets/${unknown}` },
    ])('answers 404 when removing an unknown $resource', async ({ path }) => {
      await as(harness, superAdmin).del(`${BASE}/${path}`).expect(404);
    });

    it('answers 404 for an unknown organization-scoped flag key', async () => {
      await as(harness, superAdmin)
        .put(
          `${BASE}/feature-flags/${unknown}/organizations/${organizationA}`,
          {
            enabled: true,
          },
        )
        .expect(404);
    });
  });
});
