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
  controlPlane: ['read', 'write'],
  /**
   * Separate from `controlPlane:write`, and with no read counterpart, because
   * there is nothing to read: no surface returns a stored credential. Writing
   * one is the more consequential act, so it is its own statement rather than
   * a corner of the general operator permission.
   */
  managedSecret: ['write'],
} as const;

export const globalAccessControl = createAccessControl(
  GLOBAL_PERMISSION_STATEMENTS,
);

const globalUser = globalAccessControl.newRole({
  user: [],
  session: [],
  accountLifecycle: [],
  organizationLifecycle: [],
  controlPlane: [],
  managedSecret: [],
});

const globalAdmin = globalAccessControl.newRole({
  user: ['get', 'list', 'create', 'update', 'ban', 'impersonate'],
  session: ['list', 'revoke', 'delete'],
  accountLifecycle: [],
  /**
   * The control plane is withheld from `admin`, matching the server. It turns
   * features on for the whole platform, changes the limits every organization
   * runs under, and holds the provider credentials: the blast radius is the
   * deployment, not one account.
   */
  organizationLifecycle: [],
  controlPlane: [],
  managedSecret: [],
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
  controlPlane: ['read', 'write'],
  managedSecret: ['write'],
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
export const GLOBAL_ROLE_NAMES = Object.keys(globalRoles) as GlobalRoleName[];

/**
 * Roles that may be assigned through the ordinary admin role selector.
 *
 * `super_admin` is excluded so that escalation to the highest privilege
 * level requires an explicit, deliberate action rather than a single
 * accidental dropdown change. Backend authorization remains the real
 * enforcement; this is a UI safeguard.
 */
export const ASSIGNABLE_GLOBAL_ROLE_NAMES = GLOBAL_ROLE_NAMES.filter(
  (r): r is Exclude<GlobalRoleName, 'super_admin'> => r !== 'super_admin',
);

export type AssignableGlobalRoleName = (typeof ASSIGNABLE_GLOBAL_ROLE_NAMES)[number];

export function isAssignableGlobalRoleName(value: unknown): value is AssignableGlobalRoleName {
  return typeof value === 'string' && (ASSIGNABLE_GLOBAL_ROLE_NAMES as readonly string[]).includes(value);
}

/** Membership test against the role map — never a comparison to a literal. */
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
  /**
   * The organization's own reference material. Read is ordinary membership;
   * write replaces what every future agent run reads.
   */
  knowledge: ['read', 'write'],
  contentIdea: ['create', 'read'],
  /**
   * Deciding to act on an idea. Reading is ordinary membership; creating
   * commits the organization to work the whole team will see.
   */
  contentProject: ['create', 'read'],
  /**
   * Deciding whether an agent may perform a proposed external action. Reading
   * what is waiting is membership; deciding sends a message in the
   * organization's name and belongs to whoever runs it.
   */
  agentActionApproval: ['read', 'decide'],
} as const;

export const organizationAccessControl = createAccessControl(
  ORGANIZATION_PERMISSION_STATEMENTS,
);

const organizationMember = organizationAccessControl.newRole({
  organization: [],
  member: [],
  invitation: [],
  knowledge: ['read'],
  contentIdea: ['read'],
  contentProject: ['read'],
  agentActionApproval: ['read'],
});

const organizationAdmin = organizationAccessControl.newRole({
  organization: ['update'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  knowledge: ['read', 'write'],
  contentIdea: ['create', 'read'],
  contentProject: ['create', 'read'],
  agentActionApproval: ['read', 'decide'],
});

const organizationOwner = organizationAccessControl.newRole({
  organization: ['update', 'archive', 'restore'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  knowledge: ['read', 'write'],
  contentIdea: ['create', 'read'],
  contentProject: ['create', 'read'],
  agentActionApproval: ['read', 'decide'],
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
