import {
  GLOBAL_APPLICATION_STATEMENTS,
  GLOBAL_ROLE_GRANTS,
  ORGANIZATION_PERMISSION_STATEMENTS,
  ORGANIZATION_ROLE_GRANTS,
  type GlobalRoleName,
  type OrganizationRoleName,
} from '@repo/authz-policy';
import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements } from 'better-auth/plugins/admin/access';

/**
 * UI prediction only; the backend reauthorizes every request. The policy the
 * prediction is made from is defined once in `@repo/authz-policy` and shared
 * with the backend, so what this UI offers and what the API allows cannot
 * drift apart. What stays here is presentation: the role lists the screens
 * render and the guards they narrow strings with.
 */

export const GLOBAL_PERMISSION_STATEMENTS = {
  ...defaultStatements,
  ...GLOBAL_APPLICATION_STATEMENTS,
} as const;

export const globalAccessControl = createAccessControl(
  GLOBAL_PERMISSION_STATEMENTS,
);

export const globalRoles = {
  user: globalAccessControl.newRole(GLOBAL_ROLE_GRANTS.user),
  admin: globalAccessControl.newRole(GLOBAL_ROLE_GRANTS.admin),
  super_admin: globalAccessControl.newRole(GLOBAL_ROLE_GRANTS.super_admin),
} as const;

export type { GlobalRoleName, OrganizationRoleName };

export const GLOBAL_ROLE_NAMES = Object.keys(globalRoles) as GlobalRoleName[];

export const ASSIGNABLE_GLOBAL_ROLE_NAMES = GLOBAL_ROLE_NAMES.filter(
  (r): r is Exclude<GlobalRoleName, 'super_admin'> => r !== 'super_admin',
);

export type AssignableGlobalRoleName =
  (typeof ASSIGNABLE_GLOBAL_ROLE_NAMES)[number];

export function isAssignableGlobalRoleName(
  value: unknown,
): value is AssignableGlobalRoleName {
  return (
    typeof value === 'string' &&
    (ASSIGNABLE_GLOBAL_ROLE_NAMES as readonly string[]).includes(value)
  );
}

export function isGlobalRoleName(value: unknown): value is GlobalRoleName {
  return typeof value === 'string' && value in globalRoles;
}

export function isSuperAdminRole(role?: string | null): boolean {
  if (typeof role !== 'string') return false;
  return role in { super_admin: true };
}

export function isElevatedRole(role?: string | null): boolean {
  if (typeof role !== 'string') return false;
  return role in globalRoles && !(role in { user: true });
}

// A separate instance prevents platform roles from granting tenant authority.

export { ORGANIZATION_PERMISSION_STATEMENTS };

export const organizationAccessControl = createAccessControl(
  ORGANIZATION_PERMISSION_STATEMENTS,
);

export const organizationRoles = {
  member: organizationAccessControl.newRole(ORGANIZATION_ROLE_GRANTS.member),
  admin: organizationAccessControl.newRole(ORGANIZATION_ROLE_GRANTS.admin),
  owner: organizationAccessControl.newRole(ORGANIZATION_ROLE_GRANTS.owner),
} as const;

export const ORGANIZATION_ROLE_NAMES = Object.keys(
  organizationRoles,
) as OrganizationRoleName[];

export function isOrganizationRoleName(
  value: unknown,
): value is OrganizationRoleName {
  return typeof value === 'string' && value in organizationRoles;
}
