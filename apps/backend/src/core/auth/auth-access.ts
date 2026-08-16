import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements } from 'better-auth/plugins/admin/access';

/**
 * Platform-wide authorization: what a principal may do to *the application*.
 *
 * This is one of two independent authorization domains. The other —
 * `organization-access.ts` — governs what a principal may do *inside one
 * organization*. They share no symbol, not even by accident: each builds its
 * own `AccessControl` instance, so a role object from one cannot be handed to
 * the other's plugin without a compile error. That is the mechanical reason
 * `super_admin` can never be an organization role and `owner` can never be a
 * platform role.
 */

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
} as const;

const ac = createAccessControl(GLOBAL_PERMISSION_STATEMENTS);

/** No administrative capability whatsoever. The default for every new account. */
const user = ac.newRole({
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
const admin = ac.newRole({
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
const superAdmin = ac.newRole({
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
});

export const globalAccessControl = ac;

export const globalRoles = {
  user,
  admin,
  super_admin: superAdmin,
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
