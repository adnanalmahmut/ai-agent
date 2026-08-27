import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { PrismaService } from '../../database';
import { AppException } from '../../core/errors';
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
  const prisma = {
    organization: { findUnique, updateManyAndReturn },
  } as unknown as PrismaService;

  let service: OrganizationBusinessProfileService;

  beforeEach(() => {
    findUnique.mockReset();
    updateManyAndReturn.mockReset();
    service = new OrganizationBusinessProfileService(prisma);
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
      service.replace('org-1', replacement()),
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
  });

  it('refuses a lost update when the compare-and-swap matches nothing', async () => {
    findUnique.mockResolvedValue(persisted({ businessProfileVersion: 2 }));
    updateManyAndReturn.mockResolvedValue([]);

    await expect(service.replace('org-1', replacement())).rejects.toMatchObject(
      {
        code: 'CONFLICT',
        publicDetails: { reason: 'stale_version' },
      } satisfies Partial<AppException>,
    );
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
      service.replace('org-1', replacement()),
    ).resolves.toMatchObject({ version: 2, industry: 'Research' });
  });
});
