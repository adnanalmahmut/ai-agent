import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements } from 'better-auth/plugins/admin/access';

// UI prediction only; the backend reauthorizes every request.

export const GLOBAL_PERMISSION_STATEMENTS = {
  ...defaultStatements,
  accountLifecycle: ['deactivate', 'restore'],
  organizationLifecycle: ['restore'],
  controlPlane: ['read', 'write'],
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

export const globalRoles = {
  user: globalUser,
  admin: globalAdmin,
  super_admin: globalSuperAdmin,
} as const;

export type GlobalRoleName = keyof typeof globalRoles;
export const GLOBAL_ROLE_NAMES = Object.keys(globalRoles) as GlobalRoleName[];

export const ASSIGNABLE_GLOBAL_ROLE_NAMES = GLOBAL_ROLE_NAMES.filter(
  (r): r is Exclude<GlobalRoleName, 'super_admin'> => r !== 'super_admin',
);

export type AssignableGlobalRoleName =
  (typeof ASSIGNABLE_GLOBAL_ROLE_NAMES)[number];

export function isAssignableGlobalRoleName(
  value: unknown,
): value is AssignableGlobalRoleName {
  return (
    typeof value === 'string' &&
    (ASSIGNABLE_GLOBAL_ROLE_NAMES as readonly string[]).includes(value)
  );
}

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

// A separate instance prevents platform roles from granting tenant authority.

export const ORGANIZATION_PERMISSION_STATEMENTS = {
  organization: ['update', 'delete', 'archive', 'restore'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  knowledge: ['read', 'write'],
  contentIdea: ['create', 'read'],
  contentProject: ['create', 'read'],
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

export const organizationRoles = {
  member: organizationMember,
  admin: organizationAdmin,
  owner: organizationOwner,
} as const;

export type OrganizationRoleName = keyof typeof organizationRoles;

export const ORGANIZATION_ROLE_NAMES = Object.keys(
  organizationRoles,
) as OrganizationRoleName[];

export function isOrganizationRoleName(
  value: unknown,
): value is OrganizationRoleName {
  return typeof value === 'string' && value in organizationRoles;
}
