import { Injectable } from '@nestjs/common';
import type { z } from 'zod';

import { PrismaService } from '../database';
import { AppException } from '../../core/errors';
import {
  isSuperAdminFloorViolation,
  lastSuperAdminException,
  wouldEmptySuperAdmins,
} from './super-admin-floor';
import { accountLifecycleResultSchema } from './account-lifecycle.contract';

/*
 * The payload contract is the definition; this is its application side, so a
 * change to the schema surfaces here rather than drifting away from it.
 */
export type AccountLifecycleResult = z.output<
  typeof accountLifecycleResultSchema
>;

@Injectable()
export class AccountLifecycleService {
  constructor(private readonly prisma: PrismaService) {}

  async deactivate(input: {
    userId: string;
    actorUserId: string;
    reason?: string;
  }): Promise<AccountLifecycleResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true, deletedAt: true },
    });

    if (!user) throw new AppException('USER_NOT_FOUND');
    if (user.deletedAt) {
      throw new AppException('ACCOUNT_ALREADY_DEACTIVATED', {
        userId: input.userId,
      });
    }

    if (await wouldEmptySuperAdmins(this.prisma, input.userId)) {
      throw lastSuperAdminException('deactivate');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const deactivated = await tx.user.update({
          where: { id: input.userId },
          data: {
            deletedAt: new Date(),
            deletedByUserId: input.actorUserId,
            deletionReason: input.reason ?? null,
          },
          select: { id: true, deletedAt: true },
        });

        const { count } = await tx.session.deleteMany({
          where: { userId: input.userId },
        });

        return {
          userId: deactivated.id,
          deletedAt: deactivated.deletedAt,
          revokedSessions: count,
        };
      });
    } catch (error) {
      if (isSuperAdminFloorViolation(error)) {
        throw lastSuperAdminException('deactivate');
      }

      throw error;
    }
  }

  async restore(input: { userId: string }): Promise<AccountLifecycleResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true, deletedAt: true },
    });

    if (!user) throw new AppException('USER_NOT_FOUND');
    if (!user.deletedAt) {
      throw new AppException('ACCOUNT_NOT_DEACTIVATED', {
        userId: input.userId,
      });
    }

    const restored = await this.prisma.user.update({
      where: { id: input.userId },
      data: { deletedAt: null, deletedByUserId: null, deletionReason: null },
      select: { id: true, deletedAt: true },
    });

    return {
      userId: restored.id,
      deletedAt: restored.deletedAt,
      revokedSessions: 0,
    };
  }
}
