import { useMemo } from 'react';

import { authClient } from '@/features/auth/auth-client';

import type { GlobalRoleName, OrganizationRoleName } from './permissions';

type GlobalCheck = Parameters<typeof authClient.admin.checkRolePermission>[0];
type OrganizationCheck = Parameters<
  typeof authClient.organization.checkRolePermission
>[0];

export type GlobalPermissions = GlobalCheck['permissions'];
export type OrganizationPermissions = OrganizationCheck['permissions'];

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

export function useOrganizationPermission(
  permissions: OrganizationPermissions,
): boolean {
  const { data } = authClient.useActiveMember();

  return useOrganizationRolePermission(roleOf(data), permissions);
}

function roleOf(source: unknown): string | null {
  if (typeof source !== 'object' || source === null) return null;

  const role = (source as { role?: unknown }).role;

  return typeof role === 'string' && role.length > 0 ? role : null;
}

function asGlobalRole(role: string): GlobalRoleName {
  return role as GlobalRoleName;
}

function asOrganizationRole(role: string): OrganizationRoleName {
  return role as OrganizationRoleName;
}
