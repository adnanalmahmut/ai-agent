import type { ReactNode } from 'react';

import {
  type GlobalPermissions,
  type OrganizationPermissions,
  useGlobalPermission,
  useOrganizationPermission,
} from './use-permissions';

type GateProps<Permissions> = {
  permissions: Permissions;
  children: ReactNode;
  fallback?: ReactNode;
};

export function GlobalPermissionGate({
  permissions,
  children,
  fallback = null,
}: GateProps<GlobalPermissions>) {
  const allowed = useGlobalPermission(permissions);

  return <>{allowed ? children : fallback}</>;
}

export function OrganizationPermissionGate({
  permissions,
  children,
  fallback = null,
}: GateProps<OrganizationPermissions>) {
  const allowed = useOrganizationPermission(permissions);

  return <>{allowed ? children : fallback}</>;
}
