import { Injectable } from '@nestjs/common';

import { PrismaService } from '../database';
import { Prisma } from '../generated/prisma/client';
import { AppException } from '../core/errors';
import type {
  OrganizationBusinessProfile,
  ReplaceOrganizationBusinessProfile,
} from './organization-business-profile.types';

const profileSelect = {
  id: true,
  locale: true,
  timezone: true,
  currency: true,
  legalName: true,
  industry: true,
  websiteUrl: true,
  businessDescription: true,
  businessProfileVersion: true,
  businessProfileUpdatedAt: true,
} as const;

type PersistedProfile = Prisma.OrganizationGetPayload<{
  select: typeof profileSelect;
}>;

@Injectable()
export class OrganizationBusinessProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async get(organizationId: string): Promise<OrganizationBusinessProfile> {
    const profile = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: profileSelect,
    });

    if (profile === null) {
      throw new AppException('NOT_FOUND', {
        context: { resource: 'organization' },
      });
    }

    return toProfile(profile);
  }

  async replace(
    organizationId: string,
    input: ReplaceOrganizationBusinessProfile,
  ): Promise<OrganizationBusinessProfile> {
    const current = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: profileSelect,
    });

    if (current === null) {
      throw new AppException('NOT_FOUND', {
        context: { resource: 'organization' },
      });
    }

    // A repeated request for the already-current value is idempotent even when
    // its old version token was consumed by the first successful request.
    if (matches(current, input)) return toProfile(current);

    const updated = await this.prisma.organization.updateManyAndReturn({
      where: {
        id: organizationId,
        businessProfileVersion: input.version,
      },
      data: {
        locale: input.locale,
        timezone: input.timezone,
        currency: input.currency,
        legalName: input.legalName,
        industry: input.industry,
        websiteUrl: input.websiteUrl,
        businessDescription: input.businessDescription,
        businessProfileVersion: { increment: 1 },
        businessProfileUpdatedAt: new Date(),
      },
      select: profileSelect,
    });

    if (!updated[0]) {
      // The first read and the CAS are intentionally separate. If an identical
      // request wins between them, the missed CAS is still an idempotent
      // success rather than a lost update. Re-read only on the conflict path;
      // a genuinely different winner remains a 409.
      const latest = await this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: profileSelect,
      });

      if (latest === null) {
        throw new AppException('NOT_FOUND', {
          context: { resource: 'organization' },
        });
      }

      if (matches(latest, input)) return toProfile(latest);

      throw new AppException('CONFLICT', {
        context: { resource: 'organizationBusinessProfile' },
        publicDetails: { reason: 'stale_version' },
      });
    }

    return toProfile(updated[0]);
  }
}

function matches(
  current: PersistedProfile,
  input: ReplaceOrganizationBusinessProfile,
): boolean {
  return (
    current.locale === input.locale &&
    current.timezone === input.timezone &&
    current.currency === input.currency &&
    current.legalName === input.legalName &&
    current.industry === input.industry &&
    current.websiteUrl === input.websiteUrl &&
    current.businessDescription === input.businessDescription
  );
}

function toProfile(profile: PersistedProfile): OrganizationBusinessProfile {
  return {
    organizationId: profile.id,
    version: profile.businessProfileVersion,
    locale: profile.locale as OrganizationBusinessProfile['locale'],
    timezone: profile.timezone,
    currency: profile.currency,
    legalName: profile.legalName,
    industry: profile.industry,
    websiteUrl: profile.websiteUrl,
    businessDescription: profile.businessDescription,
    updatedAt: profile.businessProfileUpdatedAt,
  };
}
