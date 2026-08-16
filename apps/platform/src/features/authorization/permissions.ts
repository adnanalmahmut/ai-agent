import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements } from 'better-auth/plugins/admin/access';

/**
 * The permission catalogue, mirrored from the server so the UI can *predict*
 * a decision without asking.
 *
 * Two things this file is not.
 *
 * It is not authorization. Every decision made here is re-derived by the
 * backend from the database on the request itself; this copy exists only to
 * decide whether to render a button. A user who edits it in their browser
 * gains a visible button and a 403.
 *
 * It is not a place for role checks. Components ask "may this permission be
 * exercised?", never "is this person an admin?" — which is what lets a role
 * gain or lose a permission here without a single component changing.
 *
 * The two domains below are built on two separate `createAccessControl`
 * instances, exactly as the backend does. Platform roles and organization
 * roles are different vocabularies that happen to share the word "admin", and
 * keeping them structurally separate is what stops one being passed where the
 * other is meant.
 */

/* ------------------------------------------------------------------ */
/* Platform (global) domain                                           */
/* ------------------------------------------------------------------ */

/**
 * Spread from Better Auth's own statements rather than retyped: the admin
 * plugin's routes check those exact strings, so a hand-copied list would
 * silently drift on the next upgrade. The two application statements are the
 * platform's own, and have no Better Auth counterpart.
 */
export const GLOBAL_PERMISSION_STATEMENTS = {
  ...defaultStatements,
  accountLifecycle: ['deactivate', 'restore'],
  organizationLifecycle: ['restore'],
} as const;

export const globalAccessControl = createAccessControl(
  GLOBAL_PERMISSION_STATEMENTS,
);

const globalUser = globalAccessControl.newRole({
  user: [],
  session: [],
  accountLifecycle: [],
  organizationLifecycle: [],
});

const globalAdmin = globalAccessControl.newRole({
  user: ['get', 'list', 'create', 'update', 'ban', 'impersonate'],
  session: ['list', 'revoke', 'delete'],
  accountLifecycle: [],
  organizationLifecycle: [],
});

const globalSuperAdmin = globalAccessControl.newRole({
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

/**
 * `user:delete` is granted to nobody, matching the server. Hard user deletion
 * is not an operation this product has — `accountLifecycle:deactivate` is the
 * reversible thing that replaced it — so no button for it should ever render.
 */
export const globalRoles = {
  user: globalUser,
  admin: globalAdmin,
  super_admin: globalSuperAdmin,
} as const;

export type GlobalRoleName = keyof typeof globalRoles;

/** Membership test against the role map — never a comparison to a literal. */
export function isGlobalRoleName(value: unknown): value is GlobalRoleName {
  return typeof value === 'string' && value in globalRoles;
}

/* ------------------------------------------------------------------ */
/* Organization domain                                                */
/* ------------------------------------------------------------------ */

/**
 * A narrowing of Better Auth's organization statements, not a copy: teams and
 * dynamic access control are switched off on the server, so their endpoints
 * are not even registered and their statements would describe UI that could
 * never work.
 */
export const ORGANIZATION_PERMISSION_STATEMENTS = {
  organization: ['update', 'delete', 'archive', 'restore'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
} as const;

export const organizationAccessControl = createAccessControl(
  ORGANIZATION_PERMISSION_STATEMENTS,
);

const organizationMember = organizationAccessControl.newRole({
  organization: [],
  member: [],
  invitation: [],
});

const organizationAdmin = organizationAccessControl.newRole({
  organization: ['update'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
});

const organizationOwner = organizationAccessControl.newRole({
  organization: ['update', 'archive', 'restore'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
});

/**
 * `organization:delete` is in the catalogue because Better Auth's own route
 * checks it, and granted to nobody because the server sets
 * `disableOrganizationDeletion` — that route answers 404. Archive is the
 * reversible operation that replaced it.
 */
export const organizationRoles = {
  member: organizationMember,
  admin: organizationAdmin,
  owner: organizationOwner,
} as const;

export type OrganizationRoleName = keyof typeof organizationRoles;

/**
 * The assignable role names, in catalogue order.
 *
 * Derived from the map rather than written out, so a role added above appears
 * in every role picker without a component being edited — and so no component
 * ever contains a role name. The assertion is the one place `Object.keys`'s
 * `string[]` is narrowed back to what the map actually holds.
 */
export const ORGANIZATION_ROLE_NAMES = Object.keys(
  organizationRoles,
) as OrganizationRoleName[];

export function isOrganizationRoleName(
  value: unknown,
): value is OrganizationRoleName {
  return typeof value === 'string' && value in organizationRoles;
}
