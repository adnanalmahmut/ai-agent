import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements } from 'better-auth/plugins/admin/access';

/**
 * The two authorization domains of this application, side by side.
 *
 * They are *two* Better Auth `AccessControl` instances and they stay two. Each
 * owns its own statement catalog and its own role objects, so a role from one
 * cannot be handed to the other's plugin without a compile error. That is the
 * mechanical reason `super_admin` can never be an organization role and
 * `owner` can never be a platform role — not a convention, not a comment.
 *
 * They live in one file because a reader deciding where a capability belongs
 * has to see both catalogs at once; that decision is the thing this file
 * exists to make hard to get wrong.
 */

/* -------------------------------------------------------------------------
 * Domain 1 — Platform: what a principal may do to *the application*.
 * ---------------------------------------------------------------------- */

/**
 * The permission catalog.
 *
 * `user` and `session` are spread from Better Auth's own admin statements
 * rather than retyped. The plugin's routes check against these exact strings
 * (`/admin/set-role` checks `user:["set-role"]`, `/admin/ban-user` checks
 * `user:["ban"]`), so copying the list by hand would let it drift from the
 * code that enforces it on a library upgrade.
 *
 * `accountLifecycle` and `organizationLifecycle` are application-owned. They
 * are not renames of Better Auth operations — see the note on `user:delete`
 * below, which is the whole point of the distinction.
 */
export const GLOBAL_PERMISSION_STATEMENTS = {
  ...defaultStatements,

  /**
   * Reversible account lifecycle, owned by this application.
   *
   * Deliberately *not* `user:delete`. That statement is Better Auth's hard,
   * irreversible row deletion; this one marks an account inactive while every
   * row — user, accounts, memberships, invitation history — stays put. Naming
   * them separately is what stops the two from being confused at a call site,
   * and no role in this file is ever granted `user:delete`.
   */
  accountLifecycle: ['deactivate', 'restore'],

  /**
   * Platform recovery for an archived organization.
   *
   * Separate from the organization's own `organization:restore` because the
   * two are genuinely different authorities: this one belongs to an operator
   * who is not a member, and it grants nothing else inside that organization.
   */
  organizationLifecycle: ['restore'],

  /**
   * The operational control plane: feature flags, runtime settings, and
   * provider credentials.
   *
   * Split into read and write rather than one statement, because they are
   * genuinely different exposures. Reading tells you which features exist and
   * how the platform is tuned; writing can switch a paid subsystem on for
   * every organization at once, or replace the credential it bills against.
   *
   * `managedSecret:write` is separate again, and no read counterpart exists,
   * because there is nothing to read: a credential's *metadata* is part of
   * `controlPlane:read` and its value is returned by no surface at all.
   */
  controlPlane: ['read', 'write'],
  managedSecret: ['write'],
} as const;

const globalAc = createAccessControl(GLOBAL_PERMISSION_STATEMENTS);

/** No administrative capability whatsoever. The default for every new account. */
const platformUser = globalAc.newRole({
  user: [],
  session: [],
  accountLifecycle: [],
  organizationLifecycle: [],
});

/**
 * Day-to-day operations.
 *
 * Holds the reversible half of user management. Everything withheld below is
 * withheld for a stated reason, not for symmetry.
 */
const platformAdmin = globalAc.newRole({
  user: [
    'get',
    'list',
    'create',
    'update',
    // Reversible, and needed for routine moderation.
    'ban',
    // Support workflow. Impersonating another *admin* additionally requires
    // `impersonate-admins`, which only `super_admin` holds.
    'impersonate',
  ],
  session: ['list', 'revoke', 'delete'],
  accountLifecycle: [],
  organizationLifecycle: [],
});

/**
 * Everything `admin` has, plus the operations that can hand out authority or
 * take over an identity.
 *
 * - `set-role`: an admin who can grant `admin` can grant `super_admin`;
 *   Better Auth's `setRole` validates only that the target role exists.
 * - `set-password` / `set-email`: full account takeover, invisible to the
 *   account's owner.
 * - `impersonate-admins`: Better Auth withholds this from its own built-in
 *   `adminAc` for the same reason.
 * - `accountLifecycle`: deactivating an account is disruptive and restoring
 *   one is a platform-authority decision that an organization owner must
 *   never be able to reach through an invitation.
 *
 * `user:delete` is absent here too. Hard deletion is not an operation this
 * application offers to anyone.
 */
const platformSuperAdmin = globalAc.newRole({
  user: [
    'get',
    'list',
    'create',
    'update',
    'ban',
    'impersonate',
    'impersonate-admins',
    'set-role',
    'set-password',
    'set-email',
  ],
  session: ['list', 'revoke', 'delete'],
  accountLifecycle: ['deactivate', 'restore'],
  organizationLifecycle: ['restore'],
  controlPlane: ['read', 'write'],
  managedSecret: ['write'],
});

export const globalAccessControl = globalAc;

export const globalRoles = {
  user: platformUser,
  admin: platformAdmin,
  super_admin: platformSuperAdmin,
} as const;

export type GlobalRoleName = keyof typeof globalRoles;

/**
 * The shape of a global permission question.
 *
 * Derived from the roles rather than written out, so a new statement widens it
 * automatically — and so no other file has to name a role to obtain the type.
 */
export type GlobalPermissionRequest = Parameters<
  (typeof globalRoles)[GlobalRoleName]['authorize']
>[0];

/**
 * Roles the admin plugin treats as administrative.
 *
 * Two consequences: `impersonate-admins` is what gates impersonating anyone
 * named here, and the plugin throws at construction if a name is missing from
 * `globalRoles` — which is why this is derived rather than written out.
 */
export const GLOBAL_ADMIN_ROLES = ['admin', 'super_admin'] as const;

export const DEFAULT_GLOBAL_ROLE = 'user' satisfies GlobalRoleName;

/**
 * The role that can grant roles, and therefore the one nothing inside the
 * authorized surface can create.
 *
 * Named here rather than at its use site for the reason every other role
 * literal is: this file is the only place a role name is allowed to be written,
 * so that adding, renaming or removing one is a compile error everywhere it
 * matters instead of a silent string mismatch. The first-run bootstrap command
 * imports this.
 */
export const SUPER_ADMIN_ROLE = 'super_admin' satisfies GlobalRoleName;

/* -------------------------------------------------------------------------
 * Domain 2 — Organization: what a principal may do *inside one organization*.
 *
 * A completely separate `AccessControl` from the platform one above. Holding a
 * global role grants nothing here, and holding an organization role grants
 * nothing there — enforced structurally, because a `Role` built from this
 * instance is not assignable to the admin plugin's `roles` map and vice
 * versa. Living in the same file changes none of that: the two never share an
 * instance, a statement catalog, or a role object.
 * ---------------------------------------------------------------------- */

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
  /**
   * The organization's own reference material.
   *
   * Split read from write because they are different exposures. Reading is
   * ordinary membership — the material is what the organization's agents will
   * be answering from, and a member unable to see it cannot tell why an answer
   * was what it was. Writing replaces what every future agent run reads, which
   * is a content decision rather than a routine one.
   */
  knowledge: ['read', 'write'],
  /**
   * Asking an agent for content ideas, and reading what it produced.
   *
   * Split for the same reason knowledge is: creating spends the platform's
   * provider credential and reading does not. Reading is ordinary membership —
   * the whole point of the feature is that a team sees the results — while
   * `create` is the action with a bill attached.
   */
  contentIdea: ['create', 'read'],
  /**
   * Deciding to act on an idea, and reading what has been decided.
   *
   * Separate from `contentIdea` rather than folded into it, because the two
   * grant different things. `contentIdea:create` spends the platform's provider
   * credential and produces nothing durable beyond a run; `contentProject:create`
   * spends nothing and commits the organization to a piece of work that
   * everyone else will see in the list. A member trusted to brainstorm is not
   * automatically the person who decides what the team is doing.
   *
   * Split `create`/`read` on the same reasoning as the two above: reading is
   * ordinary membership, since the whole point is that the team can see what
   * was chosen.
   */
  contentProject: ['create', 'read'],
} as const;

const organizationAc = createAccessControl(ORGANIZATION_PERMISSION_STATEMENTS);

/** Belongs to the organization; manages nothing in it. */
const organizationMember = organizationAc.newRole({
  organization: [],
  member: [],
  invitation: [],
  // Reading is ordinary membership; a member who cannot see the material
  // cannot tell why an agent answered as it did.
  knowledge: ['read'],
  contentIdea: ['read'],
  contentProject: ['read'],
});

/** Runs the organization day to day, but cannot end its life. */
const organizationAdmin = organizationAc.newRole({
  organization: ['update'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  knowledge: ['read', 'write'],
  contentIdea: ['create', 'read'],
  contentProject: ['create', 'read'],
});

/**
 * Everything `admin` has, plus the organization's lifecycle.
 *
 * `archive`/`restore` are withheld from `admin` because archiving takes the
 * whole organization offline for every member — a decision that belongs to
 * whoever is accountable for it, not to routine administration.
 */
const organizationOwner = organizationAc.newRole({
  organization: ['update', 'archive', 'restore'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  knowledge: ['read', 'write'],
  contentIdea: ['create', 'read'],
  contentProject: ['create', 'read'],
});

export const organizationAccessControl = organizationAc;

export const organizationRoles = {
  member: organizationMember,
  admin: organizationAdmin,
  owner: organizationOwner,
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
