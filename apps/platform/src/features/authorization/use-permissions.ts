import { useMemo } from 'react';

import { authClient } from '@/features/auth/auth-client';

import type { GlobalRoleName, OrganizationRoleName } from './permissions';

/**
 * Predicts a permission decision for the signed-in user, for display only.
 *
 * Both hooks answer from the role already in the session, with no request:
 * `checkRolePermission` evaluates the access-control definitions the client
 * plugins were given, which are the same ones the server holds. That makes a
 * gate cheap enough to use freely and, crucially, synchronous — a permission
 * check that suspended would make every guarded button flicker in.
 *
 * What they are not is a security decision. The server re-derives every one
 * of these from the database on the request itself.
 */

/** Shapes taken straight from the client, so they cannot drift from it. */
type GlobalCheck = Parameters<typeof authClient.admin.checkRolePermission>[0];
type OrganizationCheck = Parameters<
  typeof authClient.organization.checkRolePermission
>[0];

export type GlobalPermissions = GlobalCheck['permissions'];
export type OrganizationPermissions = OrganizationCheck['permissions'];

/** Platform-wide RBAC: user / admin / super_admin. */
export function useGlobalPermission(permissions: GlobalPermissions): boolean {
  const { data } = authClient.useSession();
  const role = roleOf(data?.user);

  return useMemo(() => {
    if (!role) return false;

    return authClient.admin.checkRolePermission({
      role: asGlobalRole(role),
      permissions,
    });
  }, [permissions, role]);
}

/**
 * Organization RBAC against a **named** membership role.
 *
 * This is the form to prefer anywhere the organization being acted on is known
 * — every page under `/organizations/:organizationId`. The active organization
 * and the organization on screen are not the same thing: a reader can open
 * organization B while organization A is still the session's active one, and
 * deciding B's buttons from A's membership would be wrong in both directions.
 * It would also be a bug nobody notices until someone with two organizations
 * uses the product.
 *
 * `null` grants nothing, which is the correct answer for a non-member —
 * including a platform super_admin, exactly as the backend answers.
 */
export function useOrganizationRolePermission(
  role: string | null | undefined,
  permissions: OrganizationPermissions,
): boolean {
  const name = typeof role === 'string' && role.length > 0 ? role : null;

  return useMemo(() => {
    if (!name) return false;

    return authClient.organization.checkRolePermission({
      role: asOrganizationRole(name),
      permissions,
    });
  }, [name, permissions]);
}

/**
 * Organization RBAC for the **active** organization.
 *
 * For the places that have no organization in hand — the shell, the account
 * menu — where "what may I do in whatever is currently selected" is the only
 * question that can be asked. Everywhere else, prefer the explicit form above.
 *
 * A platform super_admin with no membership gets `false` here, because an
 * active organization is context and never access.
 */
export function useOrganizationPermission(
  permissions: OrganizationPermissions,
): boolean {
  const { data } = authClient.useActiveMember();

  return useOrganizationRolePermission(roleOf(data), permissions);
}

/**
 * Narrows an unknown `role` field to a string.
 *
 * A shape check, not a comparison: the value is handed straight to the
 * access-control evaluator and no caller ever learns what it says, which is
 * what keeps `role === 'admin'` out of the component tree.
 */
function roleOf(source: unknown): string | null {
  if (typeof source !== 'object' || source === null) return null;

  const role = (source as { role?: unknown }).role;

  return typeof role === 'string' && role.length > 0 ? role : null;
}

/**
 * Better Auth stores a role as a comma-separated list and its evaluator
 * splits on commas, ignoring names it does not recognise. The published type
 * only admits one role name, so the two assertions below are where that gap
 * is bridged — once each, next to the explanation, rather than at every call
 * site. Nothing is compared: an unknown name simply grants nothing.
 */
function asGlobalRole(role: string): GlobalRoleName {
  return role as GlobalRoleName;
}

function asOrganizationRole(role: string): OrganizationRoleName {
  return role as OrganizationRoleName;
}
