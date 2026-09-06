import { Injectable } from '@nestjs/common';

import {
  memberRoleHasPermission,
  type OrganizationPermissionRequest,
} from './permissions';
import { AppException } from '../../core/errors';
import { PrismaService } from '../database';

@Injectable()
export class OrganizationAccess {
  constructor(private readonly prisma: PrismaService) {}

  async assertMay(input: {
    organizationId: string;
    actorUserId: string;
    permission: OrganizationPermissionRequest;
  }): Promise<void> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: input.organizationId },
      select: { archivedAt: true },
    });

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

    if (organization.archivedAt !== null) {
      throw new AppException('ORGANIZATION_ARCHIVED', {
        organizationId: input.organizationId,
      });
    }

    const allowed = memberRoleHasPermission(membership.role, input.permission);

    if (!allowed) throw new AppException('FORBIDDEN');
  }
}
