import { Injectable } from '@nestjs/common';

import { PrismaService } from '../database';
import { AppException } from '../../core/errors';
import {
  globalRoles,
  memberRoleHasPermission,
  type GlobalPermissionRequest,
  type GlobalRoleName,
} from './permissions';

export type ArchivedOrganizationSummary = {
  id: string;
  name: string;
  slug: string;
  archivedAt: Date;
  canRestore: boolean;
};

export type OrganizationLifecycleResult = {
  organizationId: string;
  archivedAt: Date | null;
  canceledInvitations: number;
  clearedActiveSessions: number;
};

@Injectable()
export class OrganizationLifecycleService {
  constructor(private readonly prisma: PrismaService) {}

  async assertMayPerform(input: {
    organizationId: string;
    actorUserId: string;
    actorGlobalRole: string | null | undefined;
    organizationPermission: 'archive' | 'restore';
    globalPermission?: 'restore';
  }): Promise<void> {
    if (
      input.globalPermission &&
      globalRoleHasPermission(input.actorGlobalRole, {
        organizationLifecycle: [input.globalPermission],
      })
    ) {
      return;
    }

    const membership = await this.prisma.member.findFirst({
      where: {
        organizationId: input.organizationId,
        userId: input.actorUserId,
      },
      select: { role: true },
    });

    const allowed = memberRoleHasPermission(membership?.role, {
      organization: [input.organizationPermission],
    });

    if (!allowed) throw new AppException('FORBIDDEN');
  }

  async archive(input: {
    organizationId: string;
    actorUserId: string;
    reason?: string;
  }): Promise<OrganizationLifecycleResult> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: input.organizationId },
      select: { id: true, archivedAt: true },
    });

    if (!organization) throw new AppException('NOT_FOUND');
    if (organization.archivedAt) {
      throw new AppException('ORGANIZATION_ALREADY_ARCHIVED', {
        organizationId: input.organizationId,
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const archived = await tx.organization.update({
        where: { id: input.organizationId },
        data: {
          archivedAt: new Date(),
          archivedByUserId: input.actorUserId,
          archiveReason: input.reason ?? null,
        },
        select: { id: true, archivedAt: true },
      });

      const clearedActive = await tx.session.updateMany({
        where: { activeOrganizationId: input.organizationId },
        data: { activeOrganizationId: null },
      });

      const canceled = await tx.invitation.updateMany({
        where: { organizationId: input.organizationId, status: 'pending' },
        data: { status: 'canceled' },
      });

      return {
        organizationId: archived.id,
        archivedAt: archived.archivedAt,
        canceledInvitations: canceled.count,
        clearedActiveSessions: clearedActive.count,
      };
    });
  }

  async listRestorableArchived(input: {
    actorUserId: string;
    actorGlobalRole: string | null | undefined;
  }): Promise<ArchivedOrganizationSummary[]> {
    const isPlatformRecoverer = globalRoleHasPermission(input.actorGlobalRole, {
      organizationLifecycle: ['restore'],
    });

    if (isPlatformRecoverer) {
      const archived = await this.prisma.organization.findMany({
        where: { archivedAt: { not: null } },
        select: { id: true, name: true, slug: true, archivedAt: true },
        orderBy: { archivedAt: 'desc' },
      });

      return archived.map((organization) => toSummary(organization, true));
    }

    // Memberships survive archiving, so the member rows are still the right
    // place to ask which archived organizations this person belongs to.
    const memberships = await this.prisma.member.findMany({
      where: {
        userId: input.actorUserId,
        organization: { archivedAt: { not: null } },
      },
      select: {
        role: true,
        organization: {
          select: { id: true, name: true, slug: true, archivedAt: true },
        },
      },
      orderBy: { organization: { archivedAt: 'desc' } },
    });

    return memberships
      .filter((membership) =>
        memberRoleHasPermission(membership.role, {
          organization: ['restore'],
        }),
      )
      .map((membership) => toSummary(membership.organization, true));
  }

  async restore(input: {
    organizationId: string;
  }): Promise<OrganizationLifecycleResult> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: input.organizationId },
      select: { id: true, archivedAt: true },
    });

    if (!organization) throw new AppException('NOT_FOUND');
    if (!organization.archivedAt) {
      throw new AppException('ORGANIZATION_NOT_ARCHIVED', {
        organizationId: input.organizationId,
      });
    }

    const restored = await this.prisma.organization.update({
      where: { id: input.organizationId },
      data: { archivedAt: null, archivedByUserId: null, archiveReason: null },
      select: { id: true, archivedAt: true },
    });

    return {
      organizationId: restored.id,
      archivedAt: restored.archivedAt,
      canceledInvitations: 0,
      clearedActiveSessions: 0,
    };
  }
}

function toSummary(
  organization: {
    id: string;
    name: string;
    slug: string;
    archivedAt: Date | null;
  },
  canRestore: boolean,
): ArchivedOrganizationSummary {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    // Non-null by construction: every query above filters on `archivedAt`.
    archivedAt: organization.archivedAt as Date,
    canRestore,
  };
}

function globalRoleHasPermission(
  role: string | null | undefined,
  permissions: GlobalPermissionRequest,
): boolean {
  if (!role) return false;

  return role
    .split(',')
    .map((name) => name.trim())
    .some((name) => {
      const definition = globalRoles[name as GlobalRoleName];
      return definition?.authorize(permissions).success === true;
    });
}
