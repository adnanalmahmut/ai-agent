import { Injectable } from '@nestjs/common';

import { PrismaService } from '../database';
import { AppException } from '../../core/errors';
import {
  globalRoles,
  memberRoleHasPermission,
  type GlobalPermissionRequest,
  type GlobalRoleName,
} from './permissions';

/** One archived organization, as the Platform's list needs it. */
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
  /** Pending invitations moved to `canceled`. Zero on a restore. */
  canceledInvitations: number;
  /** Sessions whose `activeOrganizationId` pointed here. Zero on a restore. */
  clearedActiveSessions: number;
};

/**
 * Reversible organization lifecycle.
 *
 * Archiving takes an organization offline without destroying anything:
 * members, invitation history and every business resource survive. Enforcement
 * of "offline" lives in `auth-hooks.ts`, which is what makes an archived
 * organization inert across Better Auth's own endpoints *and* across every
 * application route that authorizes with `@MemberHasPermission`.
 */
@Injectable()
export class OrganizationLifecycleService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Authorizes an organization lifecycle action.
   *
   * This cannot go through `@MemberHasPermission`: that decorator reaches the
   * database through `/organization/has-permission`, which the archived-org
   * hook refuses for an archived organization — correctly, since every other
   * organization operation must be refused. Restoring one therefore needs a
   * path that reads membership directly.
   *
   * It still evaluates the *same* role definitions rather than comparing role
   * names, so `owner` and `admin` mean here exactly what they mean everywhere
   * else. The `super_admin` branch is a separate global permission and grants
   * nothing inside the organization beyond this single action.
   */
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

  /**
   * Takes an organization offline.
   *
   * One transaction over three mutations that must not be observed apart:
   * marking the row, clearing every session that had it selected, and
   * canceling invitations that could otherwise be accepted into a dormant
   * organization. Invitation rows are *canceled*, never deleted — the history
   * of who was invited is worth keeping, and restoring the organization does
   * not silently re-open them.
   */
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

  /**
   * The archived organizations this caller may see, and whether they may
   * restore each one.
   *
   * A read this application has to own, because Better Auth deliberately
   * cannot answer it: `/organization/list` is filtered so an archived
   * organization is invisible to every ordinary flow, which is correct and
   * leaves exactly one gap — an owner who archives an organization would
   * otherwise have no way to find it again.
   *
   * Two kinds of caller are answered. A member whose role holds
   * `organization:restore` sees the organizations they own; a platform
   * operator holding the global `organizationLifecycle:restore` sees every
   * archived organization, because that is the recovery authority. Everybody
   * else gets an empty list rather than a refusal — "there are none you can
   * restore" is the true answer and reveals nothing.
   *
   * `canRestore` is computed here, from the same role definitions the restore
   * endpoint will evaluate again, so the UI never has to derive it from a role
   * name of its own.
   */
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

  /**
   * Brings an organization back.
   *
   * Clears the archive state and nothing else. Memberships were never removed
   * so they need no repair; invitations canceled by the archive stay canceled,
   * because re-opening an invitation somebody may have already declined — or
   * that has since expired — is a decision for whoever issues the next one.
   */
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

/**
 * Evaluates a global permission against a role string from `user.role`.
 *
 * Same shape as `memberRoleHasPermission`, against the *global* access
 * control. Comma-separated to match Better Auth's own multi-role convention.
 */
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
