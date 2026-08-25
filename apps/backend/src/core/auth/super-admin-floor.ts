import { APIError } from 'better-auth/api';

import type { PrismaService } from '../../database';
import { AppException } from '../errors';
import { SUPER_ADMIN_ROLE } from './permissions';

/**
 * Keeping at least one super administrator who can actually sign in.
 *
 * ## What the invariant is about
 *
 * Not "a row whose `role` column contains the text `super_admin`". A super
 * administrator who is banned cannot authenticate, and one who is deactivated
 * is refused a session by `createSessionDatabaseHooks`. Either one satisfies a
 * naive row count while leaving nobody able to reach the control plane, restore
 * an organization, or appoint a replacement — which is the lockout this exists
 * to prevent, and the reason the definition below is three conditions rather
 * than one.
 *
 * ## Why there are two enforcement points
 *
 * A pre-check cannot be concurrency-safe on its own. Better Auth writes through
 * its own Prisma adapter in its own transaction, so a check made in a `before`
 * hook is a separate statement in a separate transaction from the write it is
 * guarding: two administrators each demoting the other both read "two usable
 * super admins", both proceed, and the platform ends with none. Nothing about
 * ordering the check differently fixes that.
 *
 * So the *authority* is a database trigger (`20260824010000_super_admin_floor`),
 * which takes a transaction-scoped advisory lock before it counts. The second
 * transaction blocks until the first commits, then re-reads and sees zero, and
 * raises. That covers every path — this application's routes, Better Auth's own
 * routes, and any future one — because it sits under all of them.
 *
 * What lives here is the *courtesy*: the same question asked before the write,
 * so the ordinary single-actor case gets a 409 with a sentence explaining
 * itself rather than a 500 carrying a PostgreSQL exception. The two agree by
 * construction — this file and the trigger encode the same three conditions —
 * and `isSuperAdminFloorViolation` recognises the trigger's own error so the
 * racing loser is answered the same way as the caller who was simply first to
 * be told no.
 *
 * ## What it does not do
 *
 * It does not touch the bootstrap path. `super-admin:create` inserts the first
 * super administrator and the trigger fires only on `UPDATE` and `DELETE`, so
 * the host-access trust boundary that command relies on is unchanged.
 */

/** The sentinel the trigger raises with, matched rather than parsed. */
export const SUPER_ADMIN_FLOOR_SENTINEL = 'super_admin_floor_violation';

/**
 * What a mutation is about to do to an account.
 *
 * Named rather than boolean because the three read very differently in a
 * refusal and because a future fourth — an expiring ban, say — should have to
 * be classified here rather than defaulting into one of these.
 */
export type SuperAdminFloorEffect =
  'roleChange' | 'ban' | 'deactivate' | 'delete';

/** Whether a user row is a super administrator who could actually sign in. */
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

/**
 * Better Auth stores roles as a comma-separated string, so membership is a
 * split rather than a substring test.
 *
 * `role.includes('super_admin')` would also match a role literally named
 * `not_super_admin`, and — more to the point — would match nothing at all if a
 * future role were named `super_administrator`, since the test is only ever
 * asked about the exact name in `permissions.ts`.
 */
function hasSuperAdminRole(role: string | null): boolean {
  if (role === null) return false;

  return role
    .split(',')
    .map((name) => name.trim())
    .includes(SUPER_ADMIN_ROLE);
}

/**
 * Reads the users this invariant is about.
 *
 * Narrowed in the database by `contains`, then decided in memory by the split
 * above. `contains` is a filter that cannot be wrong in the direction that
 * matters — it is a superset of the exact matches — and the exact test is
 * applied to every row it returns.
 */
async function usableSuperAdmins(
  prisma: Pick<PrismaService, 'user'>,
): Promise<{ id: string }[]> {
  const candidates = await prisma.user.findMany({
    where: { role: { contains: SUPER_ADMIN_ROLE } },
    select: { id: true, role: true, banned: true, deletedAt: true },
  });

  return candidates.filter(isUsableSuperAdmin).map(({ id }) => ({ id }));
}

/**
 * Answers whether making this account unusable would empty the platform.
 *
 * Returns rather than throws, so the two callers can raise the exception each
 * of their boundaries understands: Better Auth's routes need an `APIError` to
 * produce a native response, and the application's own routes need an
 * `AppException` so the unified filter localizes it.
 */
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

/** The application-route form of the refusal. */
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

/**
 * The Better Auth form of the refusal.
 *
 * `CONFLICT` matches the application's own status for this code, so a client
 * that branches on the status gets the same answer whichever surface refused
 * it. The `code` is the machine-readable half and is the same string in both.
 */
export function lastSuperAdminApiError(): APIError {
  return new APIError('CONFLICT', {
    message:
      'The platform must keep at least one super administrator who can sign in. Appoint another before removing this one.',
    code: 'LAST_SUPER_ADMIN',
  });
}

/**
 * Recognises the database trigger's refusal.
 *
 * Matched on the sentinel the trigger raises rather than on a SQLSTATE,
 * because Prisma surfaces a trigger exception from a non-raw query as an
 * unknown-request error whose structured fields vary by adapter version while
 * the message text carries what the trigger said. The sentinel is a fixed
 * string chosen so it cannot appear in an unrelated message.
 */
export function isSuperAdminFloorViolation(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes(SUPER_ADMIN_FLOOR_SENTINEL)
  );
}
