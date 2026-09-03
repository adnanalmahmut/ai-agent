import { describe, expect, it } from '@jest/globals';
import { defaultStatements as adminDefaultStatements } from 'better-auth/plugins/admin/access';
import { defaultStatements as organizationDefaultStatements } from 'better-auth/plugins/organization/access';

import {
  DEFAULT_GLOBAL_ROLE,
  GLOBAL_ADMIN_ROLES,
  GLOBAL_PERMISSION_STATEMENTS,
  globalAccessControl,
  globalRoles,
  ORGANIZATION_CREATOR_ROLE,
  ORGANIZATION_PERMISSION_STATEMENTS,
  memberRoleHasPermission,
  organizationAccessControl,
  organizationRoles,
} from '../../../../src/infrastructure/auth/permissions';

const allowsGlobal = (
  role: keyof typeof globalRoles,
  permissions: Record<string, string[]>,
) => globalRoles[role].authorize(permissions).success;

const allowsOrganization = (
  role: keyof typeof organizationRoles,
  permissions: Record<string, string[]>,
) => organizationRoles[role].authorize(permissions).success;
describe('global access control', () => {
  describe('permission catalog', () => {
    it('inherits every Better Auth admin statement verbatim', () => {
      for (const [resource, actions] of Object.entries(
        adminDefaultStatements,
      )) {
        expect(GLOBAL_PERMISSION_STATEMENTS).toHaveProperty(resource);
        expect([
          ...(
            GLOBAL_PERMISSION_STATEMENTS as Record<string, readonly string[]>
          )[resource],
        ]).toEqual([...actions]);
      }
    });

    it('adds application-owned lifecycle statements', () => {
      expect(GLOBAL_PERMISSION_STATEMENTS.accountLifecycle).toEqual([
        'deactivate',
        'restore',
      ]);
      expect(GLOBAL_PERMISSION_STATEMENTS.organizationLifecycle).toEqual([
        'restore',
      ]);
    });
  });

  describe('user', () => {
    it('is the default role for a new account', () => {
      expect(DEFAULT_GLOBAL_ROLE).toBe('user');
    });

    it('holds no administrative permission at all', () => {
      for (const [resource, actions] of Object.entries(
        GLOBAL_PERMISSION_STATEMENTS,
      )) {
        for (const action of actions) {
          expect(allowsGlobal('user', { [resource]: [action] })).toBe(false);
        }
      }
    });
  });

  describe('admin', () => {
    it.each([
      ['user', 'get'],
      ['user', 'list'],
      ['user', 'create'],
      ['user', 'update'],
      ['user', 'ban'],
      ['user', 'impersonate'],
      ['session', 'list'],
      ['session', 'revoke'],
      ['session', 'delete'],
    ])('may %s:%s', (resource, action) => {
      expect(allowsGlobal('admin', { [resource]: [action] })).toBe(true);
    });

    it.each([
      ['user', 'set-role'],
      ['user', 'set-password'],
      ['user', 'set-email'],
      ['user', 'impersonate-admins'],
      ['accountLifecycle', 'deactivate'],
      ['accountLifecycle', 'restore'],
      ['organizationLifecycle', 'restore'],
      ['controlPlane', 'read'],
      ['controlPlane', 'write'],
      ['managedSecret', 'write'],
    ])('may not %s:%s', (resource, action) => {
      expect(allowsGlobal('admin', { [resource]: [action] })).toBe(false);
    });
  });

  describe('super_admin', () => {
    it.each([
      ['controlPlane', 'read'],
      ['controlPlane', 'write'],
      ['managedSecret', 'write'],
      ['user', 'set-role'],
      ['user', 'set-password'],
      ['user', 'set-email'],
      ['user', 'impersonate-admins'],
      ['accountLifecycle', 'deactivate'],
      ['accountLifecycle', 'restore'],
      ['organizationLifecycle', 'restore'],
    ])('may %s:%s', (resource, action) => {
      expect(allowsGlobal('super_admin', { [resource]: [action] })).toBe(true);
    });

    it('is a strict superset of admin', () => {
      for (const [resource, actions] of Object.entries(
        GLOBAL_PERMISSION_STATEMENTS,
      )) {
        for (const action of actions) {
          if (!allowsGlobal('admin', { [resource]: [action] })) continue;
          expect(allowsGlobal('super_admin', { [resource]: [action] })).toBe(
            true,
          );
        }
      }
    });
  });

  describe('hard delete is unreachable', () => {
    it.each(Object.keys(globalRoles) as (keyof typeof globalRoles)[])(
      '%s is not granted user:delete',
      (role) => {
        expect(allowsGlobal(role, { user: ['delete'] })).toBe(false);
      },
    );

    it('offers a reversible alternative instead of renaming the destructive one', () => {
      expect(allowsGlobal('super_admin', { user: ['delete'] })).toBe(false);
      expect(
        allowsGlobal('super_admin', { accountLifecycle: ['deactivate'] }),
      ).toBe(true);
    });
  });

  describe('admin roles', () => {
    it('names only roles that exist', () => {
      for (const role of GLOBAL_ADMIN_ROLES) {
        expect(Object.keys(globalRoles)).toContain(role);
      }
    });

    it('does not treat the default role as administrative', () => {
      expect(GLOBAL_ADMIN_ROLES as readonly string[]).not.toContain('user');
    });
  });

  it('denies a resource the role never declared', () => {
    expect(allowsGlobal('admin', { organization: ['update'] })).toBe(false);
  });
});

const OWN_ORGANIZATION_RESOURCES: readonly string[] = [
  'knowledge',
  'contentIdea',
  'contentProject',
  'agentActionApproval',
  'mcpSession',
];

const MEMBER_GRANTS: ReadonlyArray<[string, string]> = [
  ['knowledge', 'read'],
  ['contentIdea', 'read'],
  ['contentProject', 'read'],
  ['agentActionApproval', 'read'],
];

describe('organization access control', () => {
  describe('permission catalog', () => {
    it('narrows Better Auth defaults rather than redefining them', () => {
      for (const [resource, actions] of Object.entries(
        ORGANIZATION_PERMISSION_STATEMENTS,
      )) {
        const upstream = (
          organizationDefaultStatements as Record<string, readonly string[]>
        )[resource];

        if (OWN_ORGANIZATION_RESOURCES.includes(resource)) {
          expect(upstream).toBeUndefined();
          continue;
        }

        expect(upstream).toBeDefined();

        for (const action of actions) {
          if (action === 'archive' || action === 'restore') continue;
          expect(upstream).toContain(action);
        }
      }
    });

    it('omits team and dynamic-role statements', () => {
      expect(ORGANIZATION_PERMISSION_STATEMENTS).not.toHaveProperty('team');
      expect(ORGANIZATION_PERMISSION_STATEMENTS).not.toHaveProperty('ac');
    });
  });

  describe('member', () => {
    it('holds only the grants a member is meant to have', () => {
      for (const [resource, actions] of Object.entries(
        ORGANIZATION_PERMISSION_STATEMENTS,
      )) {
        for (const action of actions) {
          const granted = MEMBER_GRANTS.some(
            ([grantedResource, grantedAction]) =>
              grantedResource === resource && grantedAction === action,
          );

          expect(allowsOrganization('member', { [resource]: [action] })).toBe(
            granted,
          );
        }
      }
    });

    it('reads the knowledge base but cannot change it', () => {
      expect(allowsOrganization('member', { knowledge: ['read'] })).toBe(true);
      expect(allowsOrganization('member', { knowledge: ['write'] })).toBe(
        false,
      );
    });

    it('sees proposed agent actions but cannot decide them', () => {
      expect(
        allowsOrganization('member', { agentActionApproval: ['read'] }),
      ).toBe(true);
      expect(
        allowsOrganization('member', { agentActionApproval: ['decide'] }),
      ).toBe(false);
    });
  });

  describe('admin', () => {
    it.each([
      ['organization', 'update'],
      ['member', 'create'],
      ['member', 'update'],
      ['member', 'delete'],
      ['invitation', 'create'],
      ['invitation', 'cancel'],
      ['agentActionApproval', 'read'],
      ['agentActionApproval', 'decide'],
    ])('may %s:%s', (resource, action) => {
      expect(allowsOrganization('admin', { [resource]: [action] })).toBe(true);
    });

    it('may not end the organization', () => {
      expect(allowsOrganization('admin', { organization: ['archive'] })).toBe(
        false,
      );
      expect(allowsOrganization('admin', { organization: ['restore'] })).toBe(
        false,
      );
    });
  });

  describe('owner', () => {
    it('is the role assigned to whoever creates an organization', () => {
      expect(ORGANIZATION_CREATOR_ROLE).toBe('owner');
    });

    it('owns the lifecycle', () => {
      expect(allowsOrganization('owner', { organization: ['archive'] })).toBe(
        true,
      );
      expect(allowsOrganization('owner', { organization: ['restore'] })).toBe(
        true,
      );
    });

    it('is a superset of admin', () => {
      for (const [resource, actions] of Object.entries(
        ORGANIZATION_PERMISSION_STATEMENTS,
      )) {
        for (const action of actions) {
          if (!allowsOrganization('admin', { [resource]: [action] })) continue;
          expect(allowsOrganization('owner', { [resource]: [action] })).toBe(
            true,
          );
        }
      }
    });
  });

  describe('hard delete is unreachable', () => {
    it.each(
      Object.keys(organizationRoles) as (keyof typeof organizationRoles)[],
    )('%s is not granted organization:delete', (role) => {
      expect(allowsOrganization(role, { organization: ['delete'] })).toBe(
        false,
      );
    });
  });

  describe('separation from global access control', () => {
    it('is a different AccessControl instance', () => {
      expect(organizationAccessControl).not.toBe(globalAccessControl);
    });

    it('does not share the "admin" role object with the global domain', () => {
      expect(organizationRoles.admin).not.toBe(globalRoles.admin);
    });

    it('has no role named super_admin', () => {
      expect(Object.keys(organizationRoles)).not.toContain('super_admin');
    });

    it('contributes no role name to the global domain', () => {
      expect(Object.keys(globalRoles)).not.toContain('owner');
      expect(Object.keys(globalRoles)).not.toContain('member');
    });

    it('cannot answer a global permission question', () => {
      expect(allowsOrganization('owner', { user: ['list'] })).toBe(false);
      expect(
        allowsOrganization('owner', { accountLifecycle: ['deactivate'] }),
      ).toBe(false);
    });
  });

  describe('memberRoleHasPermission', () => {
    it('evaluates a single role', () => {
      expect(
        memberRoleHasPermission('owner', { organization: ['restore'] }),
      ).toBe(true);
      expect(
        memberRoleHasPermission('admin', { organization: ['restore'] }),
      ).toBe(false);
    });

    it('evaluates a comma-separated role list', () => {
      expect(
        memberRoleHasPermission('member,owner', { organization: ['restore'] }),
      ).toBe(true);
      expect(
        memberRoleHasPermission(' member , admin ', {
          organization: ['update'],
        }),
      ).toBe(true);
    });

    it('denies a non-member', () => {
      expect(memberRoleHasPermission(null, { organization: ['restore'] })).toBe(
        false,
      );
      expect(
        memberRoleHasPermission(undefined, { organization: ['restore'] }),
      ).toBe(false);
      expect(memberRoleHasPermission('', { organization: ['restore'] })).toBe(
        false,
      );
    });

    it('denies an unknown role rather than guessing', () => {
      expect(
        memberRoleHasPermission('superuser', { organization: ['restore'] }),
      ).toBe(false);
    });

    it('denies a global role name', () => {
      expect(
        memberRoleHasPermission('super_admin', { organization: ['restore'] }),
      ).toBe(false);
    });
  });
});
