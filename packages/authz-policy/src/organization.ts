import type { RoleGrants } from './statements';

/**
 * Tenant authority: what a member may do inside one organization. Consumers
 * build this on an access control instance of its own, separate from the
 * global domain, so holding `super_admin` on the platform grants nothing here
 * and an organization role can never answer a platform question.
 *
 * `organization: 'delete'` is declared but granted to no role. The statement
 * exists because Better Auth's organization plugin checks it, and withholding
 * it from every role is how hard deletion stays unreachable.
 */
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

type OrganizationRoleGrants = RoleGrants<
  typeof ORGANIZATION_PERMISSION_STATEMENTS
>;

// Key order is public: the platform offers the first name as the invite default.
export const ORGANIZATION_ROLE_GRANTS = {
  member: {
    organization: [],
    member: [],
    invitation: [],
    // Members need source visibility to interpret agent answers.
    knowledge: ['read'],
    contentIdea: ['read'],
    contentProject: ['read'],
    agentActionApproval: ['read'],
    mcpSession: [],
  },

  admin: {
    organization: ['update'],
    member: ['create', 'update', 'delete'],
    invitation: ['create', 'cancel'],
    knowledge: ['read', 'write'],
    contentIdea: ['create', 'read'],
    contentProject: ['create', 'read'],
    agentActionApproval: ['read', 'decide'],
    mcpSession: ['create'],
  },

  owner: {
    organization: ['update', 'archive', 'restore'],
    member: ['create', 'update', 'delete'],
    invitation: ['create', 'cancel'],
    knowledge: ['read', 'write'],
    contentIdea: ['create', 'read'],
    contentProject: ['create', 'read'],
    agentActionApproval: ['read', 'decide'],
    mcpSession: ['create'],
  },
} as const satisfies Record<string, OrganizationRoleGrants>;

export type OrganizationRoleName = keyof typeof ORGANIZATION_ROLE_GRANTS;
