/**
 * The two authorization domains, asserted against the real role objects.
 *
 * Formerly `auth-access.spec.ts` and `organization-access.spec.ts`. Merged
 * because the invariant that matters most is the one *between* them — that a
 * platform role grants nothing inside an organization and an organization role
 * grants nothing on the platform — and that invariant reads as an afterthought
 * when the two catalogs are tested in separate files.
 */
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
} from '../permissions';

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
    /**
     * The plugin's routes check these exact strings — `/admin/set-role`
     * against `user:["set-role"]`, `/admin/ban-user` against `user:["ban"]`.
     * Deriving the catalog rather than retyping it is what stops a library
     * upgrade from silently leaving a route unauthorizable.
     */
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

    /**
     * Each of these is withheld for a stated reason, not for symmetry:
     * `set-role` is the privilege-escalation vector, `set-password` and
     * `set-email` are silent account takeover, `impersonate-admins` is
     * withheld by Better Auth's own built-in admin role too.
     */
    it.each([
      ['user', 'set-role'],
      ['user', 'set-password'],
      ['user', 'set-email'],
      ['user', 'impersonate-admins'],
      ['accountLifecycle', 'deactivate'],
      ['accountLifecycle', 'restore'],
      ['organizationLifecycle', 'restore'],
      /**
       * The control plane is deliberately not an administrative surface. It
       * turns features on for the whole platform, changes operational limits
       * every organization runs under, and holds the provider credentials —
       * the blast radius is the deployment, not one account, so it belongs to
       * the role the operator creates once at bootstrap.
       */
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

  /**
   * The load-bearing assertion of the whole lifecycle policy.
   *
   * `user:delete` is Better Auth's hard, irreversible row deletion. The
   * application replaces it with a reversible `accountLifecycle:deactivate`,
   * and nobody — not even `super_admin` — is granted the destructive original.
   * The e2e suite proves the same thing over HTTP.
   */
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
    /**
     * `admin()` throws at construction when a name here is missing from
     * `roles`, so this failing is the difference between a clear unit-test
     * message and an opaque boot crash.
     */
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

describe('organization access control', () => {
  describe('permission catalog', () => {
    it('narrows Better Auth defaults rather than redefining them', () => {
      for (const [resource, actions] of Object.entries(
        ORGANIZATION_PERMISSION_STATEMENTS,
      )) {
        const upstream = (
          organizationDefaultStatements as Record<string, readonly string[]>
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
          expect(allowsOrganization('member', { [resource]: [action] })).toBe(
            false,
          );
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

  /**
   * Hard organization deletion is disabled twice over: `organization:delete`
   * is granted to nobody here, and `disableOrganizationDeletion: true` turns
   * the route itself off. Archive is the lifecycle operation.
   */
  describe('hard delete is unreachable', () => {
    it.each(
      Object.keys(organizationRoles) as (keyof typeof organizationRoles)[],
    )('%s is not granted organization:delete', (role) => {
      expect(allowsOrganization(role, { organization: ['delete'] })).toBe(
        false,
      );
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
      expect(allowsOrganization('owner', { user: ['list'] })).toBe(false);
      expect(
        allowsOrganization('owner', { accountLifecycle: ['deactivate'] }),
      ).toBe(false);
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
