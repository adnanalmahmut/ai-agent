import { describe, expect, it } from '@jest/globals';
import { defaultStatements } from 'better-auth/plugins/organization/access';

import { globalAccessControl, globalRoles } from './auth-access';
import {
  ORGANIZATION_CREATOR_ROLE,
  ORGANIZATION_PERMISSION_STATEMENTS,
  memberRoleHasPermission,
  organizationAccessControl,
  organizationRoles,
} from './organization-access';

const allows = (
  role: keyof typeof organizationRoles,
  permissions: Record<string, string[]>,
) => organizationRoles[role].authorize(permissions).success;

describe('organization access control', () => {
  describe('permission catalog', () => {
    it('narrows Better Auth defaults rather than redefining them', () => {
      for (const [resource, actions] of Object.entries(
        ORGANIZATION_PERMISSION_STATEMENTS,
      )) {
        const upstream = (
          defaultStatements as Record<string, readonly string[]>
        )[resource];
        expect(upstream).toBeDefined();

        for (const action of actions) {
          // `archive` and `restore` are ours; everything else must exist
          // upstream, because the plugin's own routes check those strings.
          if (action === 'archive' || action === 'restore') continue;
          expect(upstream).toContain(action);
        }
      }
    });

    /**
     * Teams and dynamic access control are off. Their endpoints are only
     * registered when the options are enabled, so declaring the statements
     * would authorize nothing while adding tables and query cost.
     */
    it('omits team and dynamic-role statements', () => {
      expect(ORGANIZATION_PERMISSION_STATEMENTS).not.toHaveProperty('team');
      expect(ORGANIZATION_PERMISSION_STATEMENTS).not.toHaveProperty('ac');
    });
  });

  describe('member', () => {
    it('manages nothing', () => {
      for (const [resource, actions] of Object.entries(
        ORGANIZATION_PERMISSION_STATEMENTS,
      )) {
        for (const action of actions) {
          expect(allows('member', { [resource]: [action] })).toBe(false);
        }
      }
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
    ])('may %s:%s', (resource, action) => {
      expect(allows('admin', { [resource]: [action] })).toBe(true);
    });

    it('may not end the organization', () => {
      expect(allows('admin', { organization: ['archive'] })).toBe(false);
      expect(allows('admin', { organization: ['restore'] })).toBe(false);
    });
  });

  describe('owner', () => {
    it('is the role assigned to whoever creates an organization', () => {
      expect(ORGANIZATION_CREATOR_ROLE).toBe('owner');
    });

    it('owns the lifecycle', () => {
      expect(allows('owner', { organization: ['archive'] })).toBe(true);
      expect(allows('owner', { organization: ['restore'] })).toBe(true);
    });

    it('is a superset of admin', () => {
      for (const [resource, actions] of Object.entries(
        ORGANIZATION_PERMISSION_STATEMENTS,
      )) {
        for (const action of actions) {
          if (!allows('admin', { [resource]: [action] })) continue;
          expect(allows('owner', { [resource]: [action] })).toBe(true);
        }
      }
    });
  });

  /**
   * Hard organization deletion is disabled twice over: `organization:delete`
   * is granted to nobody here, and `disableOrganizationDeletion: true` turns
   * the route itself off. Archive is the lifecycle operation.
   */
  describe('hard delete is unreachable', () => {
    it.each(
      Object.keys(organizationRoles) as (keyof typeof organizationRoles)[],
    )('%s is not granted organization:delete', (role) => {
      expect(allows(role, { organization: ['delete'] })).toBe(false);
    });
  });

  /**
   * The structural half of "two authorization domains". These are separate
   * `AccessControl` instances, so a role object from one is not the role
   * object from the other even where the *name* coincides.
   */
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
      expect(allows('owner', { user: ['list'] })).toBe(false);
      expect(allows('owner', { accountLifecycle: ['deactivate'] })).toBe(false);
    });
  });

  /**
   * Used by the archived-organization restore path, which cannot go through
   * `@MemberHasPermission` — see `organization-lifecycle.service.ts`.
   */
  describe('memberRoleHasPermission', () => {
    it('evaluates a single role', () => {
      expect(
        memberRoleHasPermission('owner', { organization: ['restore'] }),
      ).toBe(true);
      expect(
        memberRoleHasPermission('admin', { organization: ['restore'] }),
      ).toBe(false);
    });

    /** Better Auth joins multiple roles with a comma; so does this. */
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

    /** A global role name must not resolve inside the organization domain. */
    it('denies a global role name', () => {
      expect(
        memberRoleHasPermission('super_admin', { organization: ['restore'] }),
      ).toBe(false);
    });
  });
});
