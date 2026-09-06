import { APIError } from 'better-auth/api';

import type { PrismaService } from '../database';
import { AppException } from '../../core/errors';
import { SUPER_ADMIN_ROLE } from './permissions';

export const SUPER_ADMIN_FLOOR_SENTINEL = 'super_admin_floor_violation';

export type SuperAdminFloorEffect =
  'roleChange' | 'ban' | 'deactivate' | 'delete';

export function isUsableSuperAdmin(user: {
  role: string | null;
  banned: boolean | null;
  deletedAt: Date | null;
}): boolean {
  return (
    hasSuperAdminRole(user.role) &&
    user.banned !== true &&
    user.deletedAt === null
  );
}

function hasSuperAdminRole(role: string | null): boolean {
  if (role === null) return false;

  return role
    .split(',')
    .map((name) => name.trim())
    .includes(SUPER_ADMIN_ROLE);
}

async function usableSuperAdmins(
  prisma: Pick<PrismaService, 'user'>,
): Promise<{ id: string }[]> {
  const candidates = await prisma.user.findMany({
    where: { role: { contains: SUPER_ADMIN_ROLE } },
    select: { id: true, role: true, banned: true, deletedAt: true },
  });

  return candidates.filter(isUsableSuperAdmin).map(({ id }) => ({ id }));
}

export async function wouldEmptySuperAdmins(
  prisma: Pick<PrismaService, 'user'>,
  targetUserId: string,
): Promise<boolean> {
  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, role: true, banned: true, deletedAt: true },
  });

  // Nothing to protect: the account is not one of the administrators the floor
  // is counted from, so removing it cannot lower the count.
  if (target === null || !isUsableSuperAdmin(target)) return false;

  const usable = await usableSuperAdmins(prisma);

  return usable.every((admin) => admin.id === targetUserId);
}

export function lastSuperAdminException(
  effect: SuperAdminFloorEffect,
): AppException {
  return new AppException('LAST_SUPER_ADMIN', {
    context: { resource: 'user', effect },
    publicDetails: {
      reason:
        'The platform must keep at least one super administrator who can sign in. Appoint another before removing this one.',
    },
  });
}

export function lastSuperAdminApiError(): APIError {
  return new APIError('CONFLICT', {
    message:
      'The platform must keep at least one super administrator who can sign in. Appoint another before removing this one.',
    code: 'LAST_SUPER_ADMIN',
  });
}

export function isSuperAdminFloorViolation(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes(SUPER_ADMIN_FLOOR_SENTINEL)
  );
}
