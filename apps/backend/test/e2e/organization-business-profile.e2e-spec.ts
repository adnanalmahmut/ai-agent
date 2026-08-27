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

  const path = (id = organizationId) =>
    `/organizations/${encodeURIComponent(id)}/business-profile`;

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

    organizationId = await createOrganization(owner, 'profile-acme');
    otherOrganizationId = await createOrganization(outsider, 'profile-other');
    await addMember(admin, 'admin');
    await addMember(member, 'member');
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.prisma.organization.update({
      where: { id: organizationId },
      data: {
        locale: 'ar',
        timezone: 'UTC',
        currency: 'USD',
        legalName: null,
        industry: null,
        websiteUrl: null,
        businessDescription: null,
        businessProfileVersion: 1,
        businessProfileUpdatedAt: new Date('2026-08-27T00:00:00.000Z'),
      },
    });
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
  });
});
