import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { PrismaService } from '../../database';
import { Prisma } from '../../generated/prisma/client';
import type { OrganizationBusinessProfile } from '../../organization-settings';
import {
  ORGANIZATION_AUDIT_PAGE_SIZE,
  OrganizationAuditService,
} from '../organization-audit.service';

const profile = (
  overrides: Partial<OrganizationBusinessProfile> = {},
): OrganizationBusinessProfile => ({
  organizationId: 'org-1',
  version: 1,
  locale: 'ar',
  timezone: 'UTC',
  currency: 'USD',
  legalName: null,
  industry: null,
  websiteUrl: null,
  businessDescription: null,
  updatedAt: new Date('2026-08-27T00:00:00.000Z'),
  ...overrides,
});

describe('OrganizationAuditService', () => {
  const create = jest.fn<(...args: unknown[]) => Promise<unknown>>();
  const findMany = jest.fn<(...args: unknown[]) => Promise<any[]>>();
  const prisma = {
    organizationAuditEvent: { create, findMany },
  } as unknown as PrismaService;

  let service: OrganizationAuditService;

  beforeEach(() => {
    create.mockReset();
    findMany.mockReset();
    service = new OrganizationAuditService(prisma);
  });

  it('writes only the closed business-profile projection through its transaction client', async () => {
    create.mockResolvedValue({});
    const tx = {
      organizationAuditEvent: { create },
    } as unknown as PrismaService;

    await service.recordBusinessProfileReplacement(tx, {
      organizationId: 'org-1',
      actorUserId: 'user-1',
      before: profile(),
      after: profile({
        version: 2,
        locale: 'en',
        legalName: 'Acme Limited',
        updatedAt: new Date('2026-08-27T01:00:00.000Z'),
      }),
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        organizationId: 'org-1',
        actorUserId: 'user-1',
        action: 'organizationBusinessProfile.replaced',
        subjectType: 'organizationBusinessProfile',
        subjectId: 'org-1',
        before: {
          kind: 'organizationBusinessProfile',
          version: 1,
          locale: 'ar',
          timezone: 'UTC',
          currency: 'USD',
          legalName: null,
          industry: null,
          websiteUrl: null,
          businessDescription: null,
        },
        after: {
          kind: 'organizationBusinessProfile',
          version: 2,
          locale: 'en',
          timezone: 'UTC',
          currency: 'USD',
          legalName: 'Acme Limited',
          industry: null,
          websiteUrl: null,
          businessDescription: null,
        },
      },
    });

    const serialized = JSON.stringify(create.mock.calls[0]);
    expect(serialized).not.toContain('updatedAt');
    expect(serialized).not.toContain('metadata');
  });

  /**
   * The content-project projection, asserted whole.
   *
   * A field-by-field assertion cannot notice a field arriving, and what must
   * never arrive here is the point: the caller's idempotency key, the request
   * body, the brief, and the agent's own prose. Identifiers and two closed
   * enums are the entire contract.
   */
  it('writes only the closed content-project projection through its transaction client', async () => {
    create.mockResolvedValue({});
    const tx = {
      organizationAuditEvent: { create },
    } as unknown as PrismaService;

    await service.recordContentProjectCreation(tx, {
      organizationId: 'org-1',
      actorUserId: 'user-1',
      projectId: 'proj-1',
      sourceRunId: 'run-1',
      sourceIdeaIndex: 2,
      suggestedFormat: 'carousel',
      language: 'ar',
      draftRevision: 1,
    });

    expect(create).toHaveBeenCalledTimes(1);

    const [call] = create.mock.calls as unknown as [
      [{ data: Record<string, unknown> }],
    ];
    const { data } = call[0];

    expect(data.action).toBe('contentProject.created');
    expect(data.subjectType).toBe('contentProject');
    expect(data.subjectId).toBe('proj-1');
    expect(data.organizationId).toBe('org-1');
    expect(data.actorUserId).toBe('user-1');

    // A creation has no prior state, and a fabricated empty one would suggest
    // a project that existed before it did.
    expect(data.before).toBe(Prisma.DbNull);

    expect(data.after).toEqual({
      kind: 'contentProject',
      projectId: 'proj-1',
      sourceRunId: 'run-1',
      sourceIdeaIndex: 2,
      suggestedFormat: 'carousel',
      language: 'ar',
      draftRevision: 1,
    });
  });

  /** No method on this service can append outside a caller's transaction. */
  it('offers no generic append and no way to rewrite history', () => {
    const surface = Object.getOwnPropertyNames(
      Object.getPrototypeOf(service) as object,
    ).filter((name) => name !== 'constructor');

    expect(surface.sort()).toEqual([
      'list',
      'recordBusinessProfileReplacement',
      'recordContentProjectCreation',
    ]);
  });

  it('roots the default bounded page in the organization and returns a continuation cursor', async () => {
    const rows = Array.from(
      { length: ORGANIZATION_AUDIT_PAGE_SIZE + 1 },
      (_, index) => ({
        id: `event-${String(index).padStart(2, '0')}`,
        organizationId: 'org-1',
        occurredAt: new Date(
          `2026-08-27T00:00:${String(59 - index).padStart(2, '0')}.000Z`,
        ),
        actorUserId: 'user-1',
        action: 'organizationBusinessProfile.replaced',
        subjectType: 'organizationBusinessProfile',
        subjectId: 'org-1',
        before: { kind: 'organizationBusinessProfile', version: 1 },
        after: { kind: 'organizationBusinessProfile', version: 2 },
      }),
    );
    findMany.mockResolvedValue(rows);

    const page = await service.list({ organizationId: 'org-1' });

    expect(page.items).toHaveLength(ORGANIZATION_AUDIT_PAGE_SIZE);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-1' },
        take: ORGANIZATION_AUDIT_PAGE_SIZE + 1,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      }),
    );
  });

  it.each([0, -1, 101, 1.5])(
    'refuses an invalid page size %s',
    async (limit) => {
      await expect(
        service.list({ organizationId: 'org-1', limit }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(findMany).not.toHaveBeenCalled();
    },
  );

  it('refuses an unreadable cursor instead of restarting at the newest row', async () => {
    await expect(
      service.list({ organizationId: 'org-1', cursor: 'not-a-cursor' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(findMany).not.toHaveBeenCalled();
  });
});
