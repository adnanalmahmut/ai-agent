import { Injectable } from '@nestjs/common';

import {
  memberRoleHasPermission,
  type OrganizationPermissionRequest,
} from './permissions';
import { AppException } from '../../core/errors';
import { PrismaService } from '../database';

/**
 * Authorization against the organization named in the request path.
 *
 * Not `@MemberHasPermission`. That decorator authorizes against the session's
 * *active* organization, which is a different organization from the one named
 * in the URL whenever a reader belonging to two has the other one selected —
 * so a route guarded only by the decorator would answer for A while acting on
 * B. The lifecycle controller works around this by re-checking the path
 * organization after the decorator; every route here just does the check
 * directly, once, against the organization it is about.
 *
 * The same role definitions are evaluated either way. This reads the member
 * row and asks the shared access control, so `admin` and `owner` mean here
 * exactly what they mean everywhere else, and a platform `super_admin` who is
 * not a member gets nothing — an operator's authority over the platform is not
 * authority inside a tenant's data.
 *
 * An archived organization is refused as well. Every operation on one is
 * refused elsewhere, and acting inside a dormant organization would be an
 * exception nobody chose.
 */
@Injectable()
export class OrganizationAccess {
  constructor(private readonly prisma: PrismaService) {}

  async assertMay(input: {
    organizationId: string;
    actorUserId: string;
    /** The same shape every other caller of the shared access control uses. */
    permission: OrganizationPermissionRequest;
  }): Promise<void> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: input.organizationId },
      select: { archivedAt: true },
    });

    /**
     * A 404 rather than a 403 for an organization the caller cannot see. The
     * two are indistinguishable to a non-member by design: answering 403 would
     * confirm the organization exists to anyone who guessed its id.
     */
    if (organization === null) {
      throw new AppException('NOT_FOUND', {
        context: { resource: 'organization' },
      });
    }

    const membership = await this.prisma.member.findFirst({
      where: {
        organizationId: input.organizationId,
        userId: input.actorUserId,
      },
      select: { role: true },
    });

    if (membership === null) {
      throw new AppException('NOT_FOUND', {
        context: { resource: 'organization' },
      });
    }

    /**
     * Checked after membership, not before it.
     *
     * `ORGANIZATION_ARCHIVED` is a 403 with its own code while every other
     * refusal here is a 404, so answering it to a non-member would confirm
     * that a guessed id names a real organization — the exact distinction the
     * 404 above exists to withhold. Only someone already known to belong is
     * told why the organization is unavailable.
     */
    if (organization.archivedAt !== null) {
      throw new AppException('ORGANIZATION_ARCHIVED', {
        organizationId: input.organizationId,
      });
    }

    const allowed = memberRoleHasPermission(membership.role, input.permission);

    if (!allowed) throw new AppException('FORBIDDEN');
  }
}
