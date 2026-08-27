import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

import { OrganizationAuditService } from '../../src/organization-audit';

import {
  as,
  createHarness,
  createUser,
  errorBody,
  type Harness,
  type TestUser,
} from '../support/auth-harness';

type ProfileBody = {
  organizationId: string;
  version: number;
  locale: string;
  timezone: string;
  currency: string;
  legalName: string | null;
  industry: string | null;
  websiteUrl: string | null;
  businessDescription: string | null;
  updatedAt: string;
};

type AuditState = {
  kind: 'organizationBusinessProfile';
  version: number;
  locale: string;
  timezone: string;
  currency: string;
  legalName: string | null;
  industry: string | null;
  websiteUrl: string | null;
  businessDescription: string | null;
};

type AuditEntryBody = {
  id: string;
  organizationId: string;
  occurredAt: string;
  actorUserId: string | null;
  action: string;
  subjectType: string;
  subjectId: string;
  before: AuditState | null;
  after: AuditState | null;
};

type AuditPageBody = {
  items: AuditEntryBody[];
  nextCursor: string | null;
};

const dataOf = <T>(body: unknown): T => (body as { data: T }).data;

describe('organization business profile', () => {
  let harness: Harness;
  let owner: TestUser;
  let admin: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let superAdmin: TestUser;
  let organizationId: string;
  let otherOrganizationId: string;
  let organizationSequence = 0;

  const path = (id = organizationId) =>
    `/organizations/${encodeURIComponent(id)}/business-profile`;
  const auditPath = (id = organizationId, query = '') =>
    `/organizations/${encodeURIComponent(id)}/audit-events${query}`;

  const createOrganization = async (user: TestUser, name: string) => {
    const response = await as(harness, user).post(
      '/api/auth/organization/create',
      { name, slug: `${name}-${Date.now().toString(36)}` },
    );
    expect(response.status).toBe(200);
    return (response.body as { id: string }).id;
  };

  const addMember = async (invitee: TestUser, role: string) => {
    const invite = await as(harness, owner).post(
      '/api/auth/organization/invite-member',
      { email: invitee.email, role, organizationId },
    );
    expect(invite.status).toBe(200);

    const accepted = await as(harness, invitee).post(
      '/api/auth/organization/accept-invitation',
      { invitationId: (invite.body as { id: string }).id },
    );
    expect(accepted.status).toBe(200);
  };

  const replacement = (version = 1, changed: Record<string, unknown> = {}) => ({
    version,
    locale: 'en',
    timezone: 'Europe/Istanbul',
    currency: 'TRY',
    legalName: 'Acme Limited',
    industry: 'Research',
    websiteUrl: 'https://example.com',
    businessDescription: 'A research studio.',
    ...changed,
  });

  beforeAll(async () => {
    harness = await createHarness();
    owner = await createUser(harness);
    admin = await createUser(harness);
    member = await createUser(harness);
    outsider = await createUser(harness);
    superAdmin = await createUser(harness, { role: 'super_admin' });

    otherOrganizationId = await createOrganization(outsider, 'profile-other');
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    // Audit rows cannot be deleted even by the application's database role.
    // Give every case a fresh tenant instead of weakening the invariant for
    // test cleanup or relying on history left by an earlier case.
    organizationSequence += 1;
    organizationId = await createOrganization(
      owner,
      `profile-acme-${organizationSequence}`,
    );
    await addMember(admin, 'admin');
    await addMember(member, 'member');
  });

  it('returns complete defaults to an authorized organization admin', async () => {
    const response = await as(harness, admin).get(path()).expect(200);

    expect(dataOf<ProfileBody>(response.body)).toMatchObject({
      organizationId,
      version: 1,
      locale: 'ar',
      timezone: 'UTC',
      currency: 'USD',
      legalName: null,
    });
  });

  it.each([
    ['member', () => member, 403],
    ['outsider', () => outsider, 404],
    ['global super administrator without membership', () => superAdmin, 404],
  ])('refuses a %s read', async (_label, user, status) => {
    const response = await as(harness, user()).get(path()).expect(status);
    expect(errorBody(response).errorCode).toBe(
      status === 403 ? 'FORBIDDEN' : 'NOT_FOUND',
    );
  });

  it('does not reveal another tenant through its id', async () => {
    const response = await as(harness, admin)
      .get(path(otherOrganizationId))
      .expect(404);
    expect(errorBody(response).errorCode).toBe('NOT_FOUND');
  });

  it('replaces only the typed profile and increments its version', async () => {
    const response = await as(harness, owner)
      .put(path(), replacement())
      .expect(200);

    expect(dataOf<ProfileBody>(response.body)).toMatchObject({
      organizationId,
      version: 2,
      locale: 'en',
      timezone: 'Europe/Istanbul',
      currency: 'TRY',
      legalName: 'Acme Limited',
    });

    const row = await harness.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
    });
    expect(row.metadata).toBeNull();
    expect(row.businessDescription).toBe('A research studio.');

    const events = await harness.prisma.organizationAuditEvent.findMany({
      where: { organizationId },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      organizationId,
      actorUserId: owner.id,
      action: 'organizationBusinessProfile.replaced',
      subjectType: 'organizationBusinessProfile',
      subjectId: organizationId,
      before: {
        kind: 'organizationBusinessProfile',
        version: 1,
        locale: 'ar',
        timezone: 'UTC',
        currency: 'USD',
        legalName: null,
      },
      after: {
        kind: 'organizationBusinessProfile',
        version: 2,
        locale: 'en',
        timezone: 'Europe/Istanbul',
        currency: 'TRY',
        legalName: 'Acme Limited',
      },
    });
    expect(JSON.stringify(events[0])).not.toContain('metadata');
  });

  it('allows insert/list but rejects direct database update and delete', async () => {
    const inserted = await harness.prisma.organizationAuditEvent.create({
      data: {
        organizationId,
        actorUserId: owner.id,
        action: 'organizationBusinessProfile.replaced',
        subjectType: 'organizationBusinessProfile',
        subjectId: organizationId,
      },
    });

    await expect(
      harness.prisma.organizationAuditEvent.update({
        where: { id: inserted.id },
        data: { action: 'tampered' },
      }),
    ).rejects.toThrow(/organization_audit_event_append_only/);

    await expect(
      harness.prisma.$executeRaw`
        UPDATE "organization_audit_event"
        SET "action" = 'raw-sql-tampered'
        WHERE "id" = ${inserted.id}
      `,
    ).rejects.toThrow(/organization_audit_event_append_only/);

    await expect(
      harness.prisma.$executeRaw`
        DELETE FROM "organization_audit_event"
        WHERE "id" = ${inserted.id}
      `,
    ).rejects.toThrow(/organization_audit_event_append_only/);

    await expect(
      harness.prisma.organizationAuditEvent.findUniqueOrThrow({
        where: { id: inserted.id },
      }),
    ).resolves.toMatchObject({
      id: inserted.id,
      action: 'organizationBusinessProfile.replaced',
      subjectId: organizationId,
    });

    const response = await as(harness, owner).get(auditPath()).expect(200);
    expect(dataOf<AuditPageBody>(response.body).items).toEqual([
      expect.objectContaining({ id: inserted.id, organizationId }),
    ]);
  });

  it('runs authorization before validation on writes', async () => {
    const invalid = { arbitrarySecret: 'must-not-be-parsed-or-stored' };

    expect(
      errorBody(await as(harness, member).put(path(), invalid).expect(403))
        .errorCode,
    ).toBe('FORBIDDEN');
    expect(
      errorBody(await as(harness, outsider).put(path(), invalid).expect(404))
        .errorCode,
    ).toBe('NOT_FOUND');
  });

  it('does not capture an arbitrary secret-like request field', async () => {
    const canary = 'AUDIT_SECRET_CANARY_MUST_NEVER_PERSIST';
    await as(harness, owner)
      .put(path(), replacement(1, { arbitrarySecret: canary }))
      .expect(400);

    const events = await harness.prisma.organizationAuditEvent.findMany({
      where: { organizationId },
    });
    expect(events).toHaveLength(0);
    expect(JSON.stringify(events)).not.toContain(canary);
  });

  it.each([
    ['locale', { locale: 'fr' }],
    ['timezone', { timezone: 'Mars/Olympus' }],
    ['currency', { currency: 'ZZZ' }],
    ['website', { websiteUrl: 'file:///etc/passwd' }],
    ['unknown key', { arbitraryMetadata: { anything: true } }],
  ])(
    'rejects an invalid %s without changing the row',
    async (_label, changed) => {
      await as(harness, owner).put(path(), replacement(1, changed)).expect(400);

      const row = await harness.prisma.organization.findUniqueOrThrow({
        where: { id: organizationId },
      });
      expect(row.businessProfileVersion).toBe(1);
      expect(row.locale).toBe('ar');
    },
  );

  it('allows only one of two concurrent writers to consume a version', async () => {
    const [first, second] = await Promise.all([
      as(harness, owner).put(path(), replacement(1, { industry: 'Research' })),
      as(harness, admin).put(path(), replacement(1, { industry: 'Software' })),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const row = await harness.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
    });
    expect(row.businessProfileVersion).toBe(2);
    expect(['Research', 'Software']).toContain(row.industry);
    await expect(
      harness.prisma.organizationAuditEvent.count({
        where: { organizationId },
      }),
    ).resolves.toBe(1);
  });

  it('treats two concurrent identical replacements as one idempotent write', async () => {
    const [first, second] = await Promise.all([
      as(harness, owner).put(path(), replacement()),
      as(harness, admin).put(path(), replacement()),
    ]);

    expect([first.status, second.status]).toEqual([200, 200]);
    const row = await harness.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
    });
    expect(row.businessProfileVersion).toBe(2);
    expect(row.industry).toBe('Research');
    await expect(
      harness.prisma.organizationAuditEvent.count({
        where: { organizationId },
      }),
    ).resolves.toBe(1);
  });

  it('treats a repeated stale request for the current value as a no-op', async () => {
    const first = await as(harness, owner)
      .put(path(), replacement())
      .expect(200);
    const firstBody = dataOf<ProfileBody>(first.body);

    const repeated = await as(harness, owner)
      .put(path(), replacement(1))
      .expect(200);
    const repeatedBody = dataOf<ProfileBody>(repeated.body);

    expect(repeatedBody.version).toBe(2);
    expect(repeatedBody.updatedAt).toBe(firstBody.updatedAt);
    await expect(
      harness.prisma.organizationAuditEvent.count({
        where: { organizationId },
      }),
    ).resolves.toBe(1);
  });

  it('rolls back the profile update when the audit append fails', async () => {
    const original =
      OrganizationAuditService.prototype.recordBusinessProfileReplacement.bind(
        OrganizationAuditService.prototype,
      );
    const append = jest
      .spyOn(
        OrganizationAuditService.prototype,
        'recordBusinessProfileReplacement',
      )
      .mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new Error('forced failure after audit append');
      });

    try {
      await as(harness, owner).put(path(), replacement()).expect(500);
    } finally {
      append.mockRestore();
    }

    const row = await harness.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
    });
    expect(row.businessProfileVersion).toBe(1);
    expect(row.locale).toBe('ar');
    await expect(
      harness.prisma.organizationAuditEvent.count({
        where: { organizationId },
      }),
    ).resolves.toBe(0);
  });

  it('lists a newest-first cursor page for an authorized admin', async () => {
    await as(harness, owner)
      .put(path(), replacement(1, { industry: 'Research' }))
      .expect(200);
    await as(harness, admin)
      .put(path(), replacement(2, { industry: 'Software' }))
      .expect(200);

    const firstResponse = await as(harness, admin)
      .get(auditPath(organizationId, '?limit=1'))
      .expect(200);
    const first = dataOf<AuditPageBody>(firstResponse.body);

    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({
      organizationId,
      actorUserId: admin.id,
      action: 'organizationBusinessProfile.replaced',
      subjectType: 'organizationBusinessProfile',
      subjectId: organizationId,
      before: { version: 2, industry: 'Research' },
      after: { version: 3, industry: 'Software' },
    });
    expect(first.nextCursor).toEqual(expect.any(String));

    const secondResponse = await as(harness, admin)
      .get(
        auditPath(
          organizationId,
          `?limit=1&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
        ),
      )
      .expect(200);
    const second = dataOf<AuditPageBody>(secondResponse.body);
    expect(second.items).toHaveLength(1);
    expect(second.items[0]).toMatchObject({
      actorUserId: owner.id,
      before: { version: 1 },
      after: { version: 2, industry: 'Research' },
    });
    expect(second.nextCursor).toBeNull();
  });

  it.each([
    ['member', () => member, 403],
    ['outsider', () => outsider, 404],
    ['global super administrator without membership', () => superAdmin, 404],
  ])('refuses a %s audit read', async (_label, user, status) => {
    const response = await as(harness, user()).get(auditPath()).expect(status);
    expect(errorBody(response).errorCode).toBe(
      status === 403 ? 'FORBIDDEN' : 'NOT_FOUND',
    );
  });

  it('does not reveal another tenant audit trail through its id', async () => {
    await as(harness, outsider)
      .put(path(otherOrganizationId), replacement())
      .expect(200);

    const response = await as(harness, admin)
      .get(auditPath(otherOrganizationId))
      .expect(404);
    expect(errorBody(response).errorCode).toBe('NOT_FOUND');
  });

  it('runs audit authorization before query validation', async () => {
    expect(
      errorBody(
        await as(harness, member)
          .get(auditPath(organizationId, '?limit=999'))
          .expect(403),
      ).errorCode,
    ).toBe('FORBIDDEN');
    expect(
      errorBody(
        await as(harness, outsider)
          .get(auditPath(organizationId, '?limit=999'))
          .expect(404),
      ).errorCode,
    ).toBe('NOT_FOUND');
  });

  it.each(['?limit=101', '?cursor=not-a-cursor'])(
    'refuses an invalid authorized audit query %s',
    async (query) => {
      const response = await as(harness, owner)
        .get(auditPath(organizationId, query))
        .expect(400);
      expect(errorBody(response).errorCode).toBe('VALIDATION_ERROR');
    },
  );

  it('has no product-audit mutation route', async () => {
    await as(harness, owner).del(auditPath()).expect(404);
  });
});
