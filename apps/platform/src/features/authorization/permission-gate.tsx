import type { ReactNode } from 'react';

import {
  type GlobalPermissions,
  type OrganizationPermissions,
  useGlobalPermission,
  useOrganizationPermission,
} from './use-permissions';

/**
 * Renders its children only when the signed-in user would be allowed to do
 * the thing they lead to.
 *
 * These are **UX components**. They stop a user being shown a control that
 * would fail, which is a courtesy, not a boundary — the server refuses the
 * action whatever the browser rendered. Anyone can delete the wrapper in a
 * devtools console and get a button that returns 403.
 *
 * Written as two components rather than one with a `domain` prop because the
 * two are not interchangeable: passing an organization permission where a
 * platform one belongs is exactly the mistake worth making impossible, and
 * separate props types make the compiler catch it.
 *
 * Both are open by extension: a new permission is a new value in the object
 * literal at the call site, and neither of these files changes.
 */

type GateProps<Permissions> = {
  permissions: Permissions;
  children: ReactNode;
  /** Shown instead when the permission is absent. Defaults to nothing. */
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
