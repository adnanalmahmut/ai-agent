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
 * Which permissions exist and which role holds them is defined once, in
 * `@repo/authz-policy`, and shared with the platform. This module turns that
 * policy into the Better Auth access control this application enforces with,
 * and owns what only the enforcing side needs.
 *
 * Keep platform and organization authorization in separate type domains.
 */

export const GLOBAL_PERMISSION_STATEMENTS = {
  ...defaultStatements,
  ...GLOBAL_APPLICATION_STATEMENTS,
} as const;

const globalAc = createAccessControl(GLOBAL_PERMISSION_STATEMENTS);

export const globalAccessControl = globalAc;

export const globalRoles = {
  user: globalAc.newRole(GLOBAL_ROLE_GRANTS.user),
  admin: globalAc.newRole(GLOBAL_ROLE_GRANTS.admin),
  super_admin: globalAc.newRole(GLOBAL_ROLE_GRANTS.super_admin),
} as const;

export type { GlobalRoleName, OrganizationRoleName };

export type GlobalPermissionRequest = Parameters<
  (typeof globalRoles)[GlobalRoleName]['authorize']
>[0];

export const GLOBAL_ADMIN_ROLES = ['admin', 'super_admin'] as const;

export const DEFAULT_GLOBAL_ROLE = 'user' satisfies GlobalRoleName;

export const SUPER_ADMIN_ROLE = 'super_admin' satisfies GlobalRoleName;

export { ORGANIZATION_PERMISSION_STATEMENTS };

// A separate instance prevents platform roles from granting tenant authority.
const organizationAc = createAccessControl(ORGANIZATION_PERMISSION_STATEMENTS);

export const organizationAccessControl = organizationAc;

export const organizationRoles = {
  member: organizationAc.newRole(ORGANIZATION_ROLE_GRANTS.member),
  admin: organizationAc.newRole(ORGANIZATION_ROLE_GRANTS.admin),
  owner: organizationAc.newRole(ORGANIZATION_ROLE_GRANTS.owner),
} as const;

export const ORGANIZATION_CREATOR_ROLE = 'owner' satisfies OrganizationRoleName;

export type OrganizationPermissionRequest = Parameters<
  (typeof organizationRoles)['owner']['authorize']
>[0];

export function memberRoleHasPermission(
  role: string | null | undefined,
  permissions: OrganizationPermissionRequest,
): boolean {
  if (!role) return false;

  return role
    .split(',')
    .map((name) => name.trim())
    .some((name) => {
      const definition = organizationRoles[name as OrganizationRoleName];
      return definition?.authorize(permissions).success === true;
    });
}
