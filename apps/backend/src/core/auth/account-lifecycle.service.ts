import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../database';
import { AppException } from '../errors';
import {
  isSuperAdminFloorViolation,
  lastSuperAdminException,
  wouldEmptySuperAdmins,
} from './super-admin-floor';

export type AccountLifecycleResult = {
  userId: string;
  deletedAt: Date | null;
  /** Sessions destroyed by this call. Zero on a restore. */
  revokedSessions: number;
};

/**
 * Reversible account lifecycle.
 *
 * The application never hard-deletes a user. Deactivation marks the row and
 * destroys the account's sessions; everything else — the user row, its
 * provider accounts, its organization memberships, the invitations it sent,
 * and any business resource it created — is left exactly where it was. That
 * is what makes the operation reversible, and it is why `user:delete` is
 * granted to no role in `permissions.ts`.
 *
 * Deactivation is orthogonal to Better Auth's `banned` flag. A ban is a
 * moderation decision with its own expiry; a deactivation is a lifecycle
 * state. Neither touches the other here, so restoring an account that was
 * independently banned leaves it banned.
 */
@Injectable()
export class AccountLifecycleService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Marks an account inactive and destroys its sessions.
   *
   * One transaction, because a marked-but-still-signed-in account is exactly
   * the window this operation exists to close. With no session cache, the
   * deleted rows mean the very next request from that account is a 401.
   */
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

    /**
     * Deactivation is one of the four ways to make a super administrator
     * unusable, and the only one that does not go through Better Auth — so it
     * needs the same check its routes get, for the same reason. Notably this
     * also covers the self-service route: the last super administrator
     * deactivating their own account is the single likeliest way this lockout
     * would actually happen.
     *
     * The database trigger is still the authority under concurrency. This asks
     * first so the ordinary case gets a sentence instead of a stack trace.
     */
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
      /**
       * The racing loser. Its pre-check passed because the other transaction
       * had not committed yet; the trigger blocked it, saw zero, and raised.
       * Translated here so both callers get the same 409 rather than one of
       * them getting a PostgreSQL exception as a 500.
       */
      if (isSuperAdminFloorViolation(error)) {
        throw lastSuperAdminException('deactivate');
      }

      throw error;
    }
  }

  /**
   * Clears the deactivation and nothing else.
   *
   * Deliberately narrow. It does not lift a ban, does not recreate
   * memberships that were removed while the account was inactive, and does not
   * create a session — each of those is a separate decision with a separate
   * authority, and bundling them here would let one action quietly perform
   * three.
   */
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
