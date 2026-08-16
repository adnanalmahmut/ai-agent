import { createAccessControl } from 'better-auth/plugins/access';

/**
 * Membership-scoped authorization: what a principal may do *inside one
 * organization*.
 *
 * A completely separate `AccessControl` from `auth-access.ts`. Holding a
 * global role grants nothing here, and holding an organization role grants
 * nothing there — enforced structurally, because a `Role` built from this
 * instance is not assignable to the admin plugin's `roles` map and vice
 * versa.
 */

/**
 * The organization permission catalog.
 *
 * A deliberate *narrowing* of Better Auth's defaults, not a redefinition:
 *
 * - `team` and `ac` are omitted. Teams are disabled (they would add two
 *   tables and a session column) and dynamic access control is disabled (it
 *   would add an `organizationRole` table and a JSON-permission parse on
 *   every check). Their endpoints are only registered when those options are
 *   on, so the statements would authorize nothing.
 * - `organization:delete` is kept in the catalog because Better Auth's own
 *   `/organization/delete` route checks it — but it is granted to **no**
 *   role, and `disableOrganizationDeletion` turns the route off besides.
 *   Archive is this application's lifecycle operation.
 * - `archive` / `restore` are application-owned additions.
 */
export const ORGANIZATION_PERMISSION_STATEMENTS = {
  organization: ['update', 'delete', 'archive', 'restore'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
} as const;

const ac = createAccessControl(ORGANIZATION_PERMISSION_STATEMENTS);

/** Belongs to the organization; manages nothing in it. */
const member = ac.newRole({
  organization: [],
  member: [],
  invitation: [],
});

/** Runs the organization day to day, but cannot end its life. */
const admin = ac.newRole({
  organization: ['update'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
});

/**
 * Everything `admin` has, plus the organization's lifecycle.
 *
 * `archive`/`restore` are withheld from `admin` because archiving takes the
 * whole organization offline for every member — a decision that belongs to
 * whoever is accountable for it, not to routine administration.
 */
const owner = ac.newRole({
  organization: ['update', 'archive', 'restore'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
});

export const organizationAccessControl = ac;

export const organizationRoles = {
  member,
  admin,
  owner,
} as const;

export type OrganizationRoleName = keyof typeof organizationRoles;

/** The role Better Auth assigns to whoever creates an organization. */
export const ORGANIZATION_CREATOR_ROLE = 'owner' satisfies OrganizationRoleName;

/**
 * Evaluates an organization permission against a role string read from a
 * `member` row.
 *
 * Exists for the one flow that cannot go through `@MemberHasPermission`:
 * restoring an *archived* organization. Better Auth's organization endpoints
 * are inert for an archived organization by design (see `auth-hooks.ts`), so
 * the permission check for un-archiving it has to happen outside them — while
 * still using **these** role definitions rather than a role-name comparison.
 *
 * The role string is comma-separated, matching Better Auth's own convention
 * (`parseRoles` joins arrays with `,` and `hasPermission` splits on it).
 */
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
