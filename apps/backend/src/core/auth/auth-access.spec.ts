import { describe, expect, it } from '@jest/globals';
import { defaultStatements } from 'better-auth/plugins/admin/access';

import {
  DEFAULT_GLOBAL_ROLE,
  GLOBAL_ADMIN_ROLES,
  GLOBAL_PERMISSION_STATEMENTS,
  globalRoles,
} from './auth-access';

const allows = (
  role: keyof typeof globalRoles,
  permissions: Record<string, string[]>,
) => globalRoles[role].authorize(permissions).success;

describe('global access control', () => {
  describe('permission catalog', () => {
    /**
     * The plugin's routes check these exact strings — `/admin/set-role`
     * against `user:["set-role"]`, `/admin/ban-user` against `user:["ban"]`.
     * Deriving the catalog rather than retyping it is what stops a library
     * upgrade from silently leaving a route unauthorizable.
     */
    it('inherits every Better Auth admin statement verbatim', () => {
      for (const [resource, actions] of Object.entries(defaultStatements)) {
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
          expect(allows('user', { [resource]: [action] })).toBe(false);
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
      expect(allows('admin', { [resource]: [action] })).toBe(true);
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
    ])('may not %s:%s', (resource, action) => {
      expect(allows('admin', { [resource]: [action] })).toBe(false);
    });
  });

  describe('super_admin', () => {
    it.each([
      ['user', 'set-role'],
      ['user', 'set-password'],
      ['user', 'set-email'],
      ['user', 'impersonate-admins'],
      ['accountLifecycle', 'deactivate'],
      ['accountLifecycle', 'restore'],
      ['organizationLifecycle', 'restore'],
    ])('may %s:%s', (resource, action) => {
      expect(allows('super_admin', { [resource]: [action] })).toBe(true);
    });

    it('is a strict superset of admin', () => {
      for (const [resource, actions] of Object.entries(
        GLOBAL_PERMISSION_STATEMENTS,
      )) {
        for (const action of actions) {
          if (!allows('admin', { [resource]: [action] })) continue;
          expect(allows('super_admin', { [resource]: [action] })).toBe(true);
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
        expect(allows(role, { user: ['delete'] })).toBe(false);
      },
    );

    it('offers a reversible alternative instead of renaming the destructive one', () => {
      expect(allows('super_admin', { user: ['delete'] })).toBe(false);
      expect(allows('super_admin', { accountLifecycle: ['deactivate'] })).toBe(
        true,
      );
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
    expect(allows('admin', { organization: ['update'] })).toBe(false);
  });
});
