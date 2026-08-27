import { Injectable } from '@nestjs/common';

import { PrismaService } from '../database';
import { Prisma } from '../generated/prisma/client';
import { AppException } from '../core/errors';
import { OrganizationAuditService } from '../organization-audit';
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: OrganizationAuditService,
  ) {}

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
    actorUserId: string,
  ): Promise<OrganizationBusinessProfile> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.organization.findUnique({
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

      const updated = await tx.organization.updateManyAndReturn({
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
        // If an identical request wins between the read and the CAS, the missed
        // CAS is an idempotent success and the winner already wrote the one
        // audit event. A different winner remains a 409.
        const latest = await tx.organization.findUnique({
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

      const before = toProfile(current);
      const after = toProfile(updated[0]);

      await this.audit.recordBusinessProfileReplacement(tx, {
        organizationId,
        actorUserId,
        before,
        after,
      });

      return after;
    });
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
