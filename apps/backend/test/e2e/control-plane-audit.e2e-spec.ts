import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';

import {
  as,
  createHarness,
  createUser,
  errorBody,
  type Harness,
  type TestUser,
} from '../support/auth-harness';

/**
 * The control plane's change history, against the real application.
 *
 * Three claims are only true end to end. That an acknowledged mutation and its
 * audit row commit together — which is a transaction, not a call order. That
 * history outlives the row it describes, which is the case a
 * `updatedByUserId` column structurally cannot cover. And that no credential
 * material reaches the table, the API response, or the process log, which has
 * to be checked against the bytes rather than against a projection function.
 */

const BASE = '/platform/control-plane';

const FLAG = 'content_ideas.enabled';
const SETTING = 'knowledge.retrieval_max_chunks';
const SECRET = 'openai.api_key';

/**
 * Unmistakable, and searched for in the raw stored row and the raw response.
 *
 * Long enough and prefixed correctly to pass `looksLikeCredential`, because a
 * canary the validator rejects would never reach the code path under test.
 */
const CANARY = 'sk-CANARY-audit-must-never-store-this-000';

const dataOf = <T>(body: unknown): T => (body as { data: T }).data;

type AuditEntry = {
  id: string;
  occurredAt: string;
  actorUserId: string | null;
  resource: string;
  action: string;
  resourceKey: string;
  organizationId: string | null;
  before: unknown;
  after: unknown;
};

type AuditPage = { items: AuditEntry[]; nextCursor: string | null };

describe('Control plane audit (e2e)', () => {
  let harness: Harness;
  let superAdmin: TestUser;
  let plainAdmin: TestUser;
  let plainUser: TestUser;
  let organizationId: string;

  const audit = (user: TestUser, query = '') =>
    as(harness, user).get(`${BASE}/audit${query}`);

  const rowsFor = (resourceKey: string) =>
    harness.prisma.controlPlaneAuditEvent.findMany({
      where: { resourceKey },
      orderBy: { occurredAt: 'asc' },
    });

  beforeAll(async () => {
    harness = await createHarness();

    superAdmin = await createUser(harness, { role: 'super_admin' });
    plainAdmin = await createUser(harness, { role: 'admin' });
    plainUser = await createUser(harness);

    const created = await as(harness, superAdmin).post(
      '/api/auth/organization/create',
      { name: 'audit-org', slug: `audit-org-${Date.now().toString(36)}` },
    );

    expect(created.status).toBe(200);
    organizationId = (created.body as { id: string }).id;
  });

  afterAll(async () => {
    await harness.prisma.controlPlaneAuditEvent.deleteMany({});
    await harness.close();
  });

  beforeEach(async () => {
    await harness.prisma.controlPlaneAuditEvent.deleteMany({});
    await harness.prisma.featureFlagPlatformOverride.deleteMany({});
    await harness.prisma.featureFlagOrganizationOverride.deleteMany({});
    await harness.prisma.runtimeSetting.deleteMany({});
    await harness.prisma.managedSecret.deleteMany({});
    // The resets above are writes this table does not describe, so it is
    // cleared last — otherwise the first assertion in every test would be
    // looking at the teardown.
    await harness.prisma.controlPlaneAuditEvent.deleteMany({});
  });

  describe('what is recorded', () => {
    it('records a platform override and what it replaced', async () => {
      await as(harness, superAdmin)
        .put(`${BASE}/feature-flags/${FLAG}`, { enabled: true })
        .expect(200);
      await as(harness, superAdmin)
        .put(`${BASE}/feature-flags/${FLAG}`, { enabled: false })
        .expect(200);

      const rows = await rowsFor(FLAG);

      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        resource: 'featureFlag',
        action: 'featureFlag.setPlatformOverride',
        actorUserId: superAdmin.id,
        organizationId: null,
        before: null,
        after: { kind: 'featureFlagOverride', enabled: true },
      });
      expect(rows[1]).toMatchObject({
        before: { kind: 'featureFlagOverride', enabled: true },
        after: { kind: 'featureFlagOverride', enabled: false },
      });
    });

    /**
     * The case a last-writer column cannot cover.
     *
     * Clearing an override deletes the row that carried `updatedByUserId`, so
     * without this table the fact that somebody removed it — and what it was —
     * leaves no trace anywhere. That is the moment the evidence matters most.
     */
    it('keeps the history of an override after the override is gone', async () => {
      await as(harness, superAdmin)
        .put(`${BASE}/feature-flags/${FLAG}`, { enabled: true })
        .expect(200);
      await as(harness, superAdmin)
        .del(`${BASE}/feature-flags/${FLAG}`)
        .expect(200);

      expect(
        await harness.prisma.featureFlagPlatformOverride.count({
          where: { key: FLAG },
        }),
      ).toBe(0);

      const rows = await rowsFor(FLAG);

      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({
        action: 'featureFlag.clearPlatformOverride',
        actorUserId: superAdmin.id,
        before: { kind: 'featureFlagOverride', enabled: true },
        after: null,
      });
    });

    it('records the organization an override applied to', async () => {
      await as(harness, superAdmin)
        .put(`${BASE}/feature-flags/${FLAG}/organizations/${organizationId}`, {
          enabled: true,
        })
        .expect(200);
      await as(harness, superAdmin)
        .del(`${BASE}/feature-flags/${FLAG}/organizations/${organizationId}`)
        .expect(200);

      const rows = await rowsFor(FLAG);

      expect(rows.map((row) => row.action)).toEqual([
        'featureFlag.setOrganizationOverride',
        'featureFlag.clearOrganizationOverride',
      ]);
      expect(rows.every((row) => row.organizationId === organizationId)).toBe(
        true,
      );
    });

    it('records a runtime setting and the value a reset removed', async () => {
      await as(harness, superAdmin)
        .put(`${BASE}/settings/${SETTING}`, { value: 7 })
        .expect(200);
      await as(harness, superAdmin)
        .del(`${BASE}/settings/${SETTING}`)
        .expect(200);

      const rows = await rowsFor(SETTING);

      expect(rows[0]).toMatchObject({
        resource: 'runtimeSetting',
        action: 'runtimeSetting.set',
        before: null,
        after: { kind: 'runtimeSettingValue', value: 7 },
      });
      expect(rows[1]).toMatchObject({
        action: 'runtimeSetting.reset',
        before: { kind: 'runtimeSettingValue', value: 7 },
        after: null,
      });
    });

    /**
     * Configuring and rotating are one operation and two events. "This slot has
     * never held a credential" is the fact an incident asks about, and
     * collapsing the two would lose it.
     */
    it('distinguishes configuring a credential from rotating one', async () => {
      await as(harness, superAdmin)
        .put(`${BASE}/secrets/${SECRET}`, { value: CANARY, label: 'primary' })
        .expect(200);
      await as(harness, superAdmin)
        .put(`${BASE}/secrets/${SECRET}`, { value: `${CANARY}-rotated` })
        .expect(200);
      await as(harness, superAdmin)
        .del(`${BASE}/secrets/${SECRET}`)
        .expect(200);

      const rows = await rowsFor(SECRET);

      expect(rows.map((row) => row.action)).toEqual([
        'managedSecret.configure',
        'managedSecret.rotate',
        'managedSecret.remove',
      ]);
      expect(rows[0]).toMatchObject({
        after: { kind: 'managedSecretSlot', configured: true },
      });
      expect(rows[2]).toMatchObject({
        after: { kind: 'managedSecretSlot', configured: false },
      });
    });

    /**
     * A refused mutation must leave no trace saying it happened. An audit log
     * that recorded attempts alongside changes would answer "was this ever set
     * to 5000" with a yes for a request the service rejected.
     */
    it.each([
      [
        'a setting outside its bounds',
        () =>
          as(harness, superAdmin).put(`${BASE}/settings/${SETTING}`, {
            value: 5_000,
          }),
      ],
      [
        'a credential that is not one',
        () =>
          as(harness, superAdmin).put(`${BASE}/secrets/${SECRET}`, {
            value: 'nope',
          }),
      ],
      [
        'an override for an organization that does not exist',
        () =>
          as(harness, superAdmin).put(
            `${BASE}/feature-flags/${FLAG}/organizations/org-does-not-exist`,
            { enabled: true },
          ),
      ],
      [
        'an unknown key',
        () =>
          as(harness, superAdmin).put(`${BASE}/feature-flags/not.a.flag`, {
            enabled: true,
          }),
      ],
    ])('writes no event for %s', async (unusedName, attempt) => {
      const response = await attempt();

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await harness.prisma.controlPlaneAuditEvent.count({})).toBe(0);
    });

    /**
     * A caller who is refused by authorization must likewise leave nothing.
     *
     * The guard runs before the handler, so this passing is unsurprising —
     * which is exactly why it is worth pinning: an audit written in a global
     * interceptor rather than in the service would record every attempt,
     * including the ones nobody was allowed to make.
     */
    it('writes no event for a caller who is refused', async () => {
      await as(harness, plainAdmin)
        .put(`${BASE}/feature-flags/${FLAG}`, { enabled: true })
        .expect(403);

      expect(await harness.prisma.controlPlaneAuditEvent.count({})).toBe(0);
    });
  });

  /**
   * The containment claim, checked against bytes rather than against the shape
   * the projection happens to build.
   */
  describe('secret containment', () => {
    it('never stores credential material in the audit row', async () => {
      await as(harness, superAdmin)
        .put(`${BASE}/secrets/${SECRET}`, { value: CANARY, label: 'primary' })
        .expect(200);

      const rows = await rowsFor(SECRET);
      const raw = JSON.stringify(rows);

      expect(raw).not.toContain(CANARY);
      // Nor the encrypted form of it, nor the material needed to open it.
      const stored = await harness.prisma.managedSecret.findUniqueOrThrow({
        where: { key: SECRET },
        select: { ciphertext: true, iv: true, authTag: true },
      });

      for (const bytes of [stored.ciphertext, stored.iv, stored.authTag]) {
        expect(raw).not.toContain(Buffer.from(bytes).toString('base64'));
        expect(raw).not.toContain(Buffer.from(bytes).toString('hex'));
      }
    });

    it('never returns credential material from the audit API', async () => {
      await as(harness, superAdmin)
        .put(`${BASE}/secrets/${SECRET}`, { value: CANARY })
        .expect(200);

      const response = await audit(superAdmin);

      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toContain(CANARY);
      // Not vacuous: the event is there, it simply carries no credential.
      expect(
        dataOf<AuditPage>(response.body).items.some(
          (item) => item.resourceKey === SECRET,
        ),
      ).toBe(true);
    });

    /**
     * And the process log. `ManagedSecretService` already asserts this for its
     * own paths in a unit spec; the audit write is a new path through the same
     * data, so the whole request is exercised with the log captured.
     */
    it('never writes credential material to the log', async () => {
      const captured: unknown[] = [];
      const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
      const originals = methods.map(
        (method) => [method, console[method].bind(console)] as const,
      );

      for (const method of methods) {
        console[method] = (...args: unknown[]) => {
          captured.push(args);
        };
      }

      try {
        await as(harness, superAdmin)
          .put(`${BASE}/secrets/${SECRET}`, { value: CANARY })
          .expect(200);
        await as(harness, superAdmin)
          .del(`${BASE}/secrets/${SECRET}`)
          .expect(200);
      } finally {
        for (const [method, original] of originals) {
          console[method] = original;
        }
      }

      expect(JSON.stringify(captured)).not.toContain(CANARY);
    });
  });

  describe('the read surface', () => {
    /** Enough events that paging has something to page. */
    const seed = async (count: number) => {
      for (let index = 0; index < count; index += 1) {
        await as(harness, superAdmin)
          .put(`${BASE}/settings/${SETTING}`, { value: (index % 90) + 1 })
          .expect(200);
      }
    };

    it('is newest first', async () => {
      await seed(3);

      const items = dataOf<AuditPage>((await audit(superAdmin)).body).items;

      expect(items).toHaveLength(3);

      const times = items.map((item) => new Date(item.occurredAt).getTime());

      expect([...times].sort((left, right) => right - left)).toEqual(times);
    });

    it('walks the whole history exactly once', async () => {
      await seed(5);

      const seen: string[] = [];
      let cursor: string | null = null;
      let requests = 0;

      do {
        const query: string = `?limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
        const page: AuditPage = dataOf<AuditPage>(
          (await audit(superAdmin, query)).body,
        );

        seen.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
        requests += 1;

        expect(requests).toBeLessThan(10);
      } while (cursor !== null);

      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    });

    it('filters by resource and by key', async () => {
      await as(harness, superAdmin)
        .put(`${BASE}/settings/${SETTING}`, { value: 7 })
        .expect(200);
      await as(harness, superAdmin)
        .put(`${BASE}/feature-flags/${FLAG}`, { enabled: true })
        .expect(200);

      const settings = dataOf<AuditPage>(
        (await audit(superAdmin, '?resource=runtimeSetting')).body,
      );

      expect(settings.items).toHaveLength(1);
      expect(settings.items[0]?.resourceKey).toBe(SETTING);

      const byKey = dataOf<AuditPage>(
        (await audit(superAdmin, `?resourceKey=${FLAG}`)).body,
      );

      expect(byKey.items).toHaveLength(1);
      expect(byKey.items[0]?.action).toBe('featureFlag.setPlatformOverride');
    });

    it.each([
      '?limit=0',
      '?limit=5000',
      '?cursor=not-a-cursor',
      '?resource=nope',
    ])('refuses %s', async (query) => {
      expect((await audit(superAdmin, query)).status).toBe(400);
    });

    /**
     * `controlPlane:read` and not a permission of its own: the log's contents
     * are a subset of what that grant already shows, plus who changed them.
     * Notably `managedSecret:write` is not required — reading that a credential
     * was rotated is not the same authority as rotating one.
     */
    it('is refused to anyone without control-plane read', async () => {
      for (const user of [plainUser, plainAdmin]) {
        const response = await audit(user);

        expect(response.status).toBe(403);
        expect(errorBody(response).errorCode).toBe('FORBIDDEN');
      }
    });

    /**
     * Append-only, enforced by the absence of a handler rather than by a grant.
     * A route that appeared later would make the table's promise false, so the
     * verbs are probed directly.
     */
    it.each(['post', 'put', 'del'] as const)(
      'offers no %s on the audit route',
      async (method) => {
        const response = await as(harness, superAdmin)[method](`${BASE}/audit`);

        expect(response.status).toBe(404);
      },
    );
  });

  /**
   * The mutation and its audit row commit together.
   *
   * Asserted by breaking the audit write and observing that the mutation did
   * not happen either. Written the other way round it would prove nothing: the
   * two agreeing on the happy path is what a call in sequence looks like as
   * well, and the case worth knowing about is a process that died between them.
   */
  it('does not acknowledge a write whose audit row cannot be stored', async () => {
    await harness.prisma.$executeRawUnsafe(
      `ALTER TABLE "control_plane_audit_event" ADD CONSTRAINT audit_refuses CHECK (false) NOT VALID`,
    );

    try {
      const response = await as(harness, superAdmin).put(
        `${BASE}/settings/${SETTING}`,
        { value: 9 },
      );

      expect(response.status).toBeGreaterThanOrEqual(500);

      // The setting was not changed, because the transaction rolled back.
      expect(
        await harness.prisma.runtimeSetting.count({ where: { key: SETTING } }),
      ).toBe(0);
    } finally {
      await harness.prisma.$executeRawUnsafe(
        `ALTER TABLE "control_plane_audit_event" DROP CONSTRAINT audit_refuses`,
      );
    }
  });
});
