import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements } from 'better-auth/plugins/admin/access';

// Keep platform and organization authorization in separate type domains.

export const GLOBAL_PERMISSION_STATEMENTS = {
  ...defaultStatements,

  accountLifecycle: ['deactivate', 'restore'],

  organizationLifecycle: ['restore'],

  controlPlane: ['read', 'write'],
  managedSecret: ['write'],
} as const;

const globalAc = createAccessControl(GLOBAL_PERMISSION_STATEMENTS);

const platformUser = globalAc.newRole({
  user: [],
  session: [],
  accountLifecycle: [],
  organizationLifecycle: [],
});

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

export type GlobalPermissionRequest = Parameters<
  (typeof globalRoles)[GlobalRoleName]['authorize']
>[0];

export const GLOBAL_ADMIN_ROLES = ['admin', 'super_admin'] as const;

export const DEFAULT_GLOBAL_ROLE = 'user' satisfies GlobalRoleName;

export const SUPER_ADMIN_ROLE = 'super_admin' satisfies GlobalRoleName;

export const ORGANIZATION_PERMISSION_STATEMENTS = {
  organization: ['update', 'delete', 'archive', 'restore'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  knowledge: ['read', 'write'],
  contentIdea: ['create', 'read'],
  contentProject: ['create', 'read'],
  agentActionApproval: ['read', 'decide'],
  mcpSession: ['create'],
} as const;

const organizationAc = createAccessControl(ORGANIZATION_PERMISSION_STATEMENTS);

const organizationMember = organizationAc.newRole({
  organization: [],
  member: [],
  invitation: [],
  // Members need source visibility to interpret agent answers.
  knowledge: ['read'],
  contentIdea: ['read'],
  contentProject: ['read'],
  agentActionApproval: ['read'],
  mcpSession: [],
});

const organizationAdmin = organizationAc.newRole({
  organization: ['update'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  knowledge: ['read', 'write'],
  contentIdea: ['create', 'read'],
  contentProject: ['create', 'read'],
  agentActionApproval: ['read', 'decide'],
  mcpSession: ['create'],
});

const organizationOwner = organizationAc.newRole({
  organization: ['update', 'archive', 'restore'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  knowledge: ['read', 'write'],
  contentIdea: ['create', 'read'],
  contentProject: ['create', 'read'],
  agentActionApproval: ['read', 'decide'],
  mcpSession: ['create'],
});

export const organizationAccessControl = organizationAc;

export const organizationRoles = {
  member: organizationMember,
  admin: organizationAdmin,
  owner: organizationOwner,
} as const;

export type OrganizationRoleName = keyof typeof organizationRoles;

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
