import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { PrismaService } from '../../database';
import { AppException } from '../../core/errors';
import type { OrganizationAuditService } from '../../organization-audit';
import { OrganizationBusinessProfileService } from '../organization-business-profile.service';
import type { ReplaceOrganizationBusinessProfile } from '../organization-business-profile.types';

const persisted = (overrides: Record<string, unknown> = {}) => ({
  id: 'org-1',
  locale: 'ar',
  timezone: 'UTC',
  currency: 'USD',
  legalName: null,
  industry: null,
  websiteUrl: null,
  businessDescription: null,
  businessProfileVersion: 1,
  businessProfileUpdatedAt: new Date('2026-08-27T00:00:00.000Z'),
  ...overrides,
});

const replacement = (
  overrides: Partial<ReplaceOrganizationBusinessProfile> = {},
): ReplaceOrganizationBusinessProfile => ({
  version: 1,
  locale: 'en',
  timezone: 'Europe/Istanbul',
  currency: 'TRY',
  legalName: 'Acme Limited',
  industry: 'Research',
  websiteUrl: 'https://example.com',
  businessDescription: 'A research studio.',
  ...overrides,
});

describe('OrganizationBusinessProfileService', () => {
  const findUnique = jest.fn<(...args: unknown[]) => Promise<any>>();
  const updateManyAndReturn = jest.fn<(...args: unknown[]) => Promise<any[]>>();
  const transaction =
    jest.fn<
      (callback: (tx: PrismaService) => Promise<unknown>) => Promise<unknown>
    >();
  const recordBusinessProfileReplacement =
    jest.fn<(...args: unknown[]) => Promise<void>>();
  const prisma = {
    organization: { findUnique, updateManyAndReturn },
    $transaction: transaction,
  } as unknown as PrismaService;
  const audit = {
    recordBusinessProfileReplacement,
  } as unknown as OrganizationAuditService;

  let service: OrganizationBusinessProfileService;

  beforeEach(() => {
    findUnique.mockReset();
    updateManyAndReturn.mockReset();
    transaction.mockReset();
    transaction.mockImplementation((callback) => callback(prisma));
    recordBusinessProfileReplacement.mockReset();
    recordBusinessProfileReplacement.mockResolvedValue();
    service = new OrganizationBusinessProfileService(prisma, audit);
  });

  it('returns a no-op without consuming a version', async () => {
    const current = persisted();
    findUnique.mockResolvedValue(current);

    await expect(
      service.replace(
        'org-1',
        replacement({
          locale: 'ar',
          timezone: 'UTC',
          currency: 'USD',
          legalName: null,
          industry: null,
          websiteUrl: null,
          businessDescription: null,
        }),
        'user-1',
      ),
    ).resolves.toMatchObject({ version: 1, locale: 'ar' });
    expect(updateManyAndReturn).not.toHaveBeenCalled();
  });

  it('matches the version and writes only owned fields', async () => {
    findUnique.mockResolvedValue(persisted());
    updateManyAndReturn.mockResolvedValue([
      persisted({
        ...replacement(),
        businessProfileVersion: 2,
        businessProfileUpdatedAt: new Date('2026-08-27T01:00:00.000Z'),
      }),
    ]);

    await expect(
      service.replace('org-1', replacement(), 'user-1'),
    ).resolves.toMatchObject({
      version: 2,
      currency: 'TRY',
    });

    expect(updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'org-1', businessProfileVersion: 1 },
        data: expect.objectContaining({
          locale: 'en',
          timezone: 'Europe/Istanbul',
          currency: 'TRY',
          businessProfileVersion: { increment: 1 },
        }),
      }),
    );
    const data = (updateManyAndReturn.mock.calls[0]?.[0] as { data: object })
      .data;
    expect(data).not.toHaveProperty('organizationId');
    expect(data).not.toHaveProperty('metadata');
    expect(recordBusinessProfileReplacement).toHaveBeenCalledWith(prisma, {
      organizationId: 'org-1',
      actorUserId: 'user-1',
      before: expect.objectContaining({ version: 1, locale: 'ar' }),
      after: expect.objectContaining({ version: 2, locale: 'en' }),
    });
  });

  it('refuses a lost update when the compare-and-swap matches nothing', async () => {
    findUnique.mockResolvedValue(persisted({ businessProfileVersion: 2 }));
    updateManyAndReturn.mockResolvedValue([]);

    await expect(
      service.replace('org-1', replacement(), 'user-1'),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      publicDetails: { reason: 'stale_version' },
    } satisfies Partial<AppException>);
    expect(recordBusinessProfileReplacement).not.toHaveBeenCalled();
  });

  it('accepts an identical request that wins concurrently', async () => {
    findUnique.mockResolvedValueOnce(persisted()).mockResolvedValueOnce(
      persisted({
        ...replacement(),
        businessProfileVersion: 2,
        businessProfileUpdatedAt: new Date('2026-08-27T01:00:00.000Z'),
      }),
    );
    updateManyAndReturn.mockResolvedValue([]);

    await expect(
      service.replace('org-1', replacement(), 'user-1'),
    ).resolves.toMatchObject({ version: 2, industry: 'Research' });
    expect(recordBusinessProfileReplacement).not.toHaveBeenCalled();
  });

  it('propagates an audit append failure from the mutation transaction', async () => {
    findUnique.mockResolvedValue(persisted());
    updateManyAndReturn.mockResolvedValue([
      persisted({
        ...replacement(),
        businessProfileVersion: 2,
        businessProfileUpdatedAt: new Date('2026-08-27T01:00:00.000Z'),
      }),
    ]);
    recordBusinessProfileReplacement.mockRejectedValue(
      new Error('audit append failed'),
    );

    await expect(
      service.replace('org-1', replacement(), 'user-1'),
    ).rejects.toThrow('audit append failed');
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
