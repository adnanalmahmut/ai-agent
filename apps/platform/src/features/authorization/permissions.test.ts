import {
  GLOBAL_ROLE_GRANTS,
  ORGANIZATION_ROLE_GRANTS,
} from '@repo/authz-policy';
import { defaultStatements } from 'better-auth/plugins/admin/access';
import { describe, expect, it } from 'vitest';

import {
  GLOBAL_PERMISSION_STATEMENTS,
  ORGANIZATION_PERMISSION_STATEMENTS,
  globalAccessControl,
  globalRoles,
  isGlobalRoleName,
  isOrganizationRoleName,
  organizationAccessControl,
  organizationRoles,
} from './permissions';

const allows = (
  role: { authorize: (request: never) => { success: boolean } },
  request: unknown,
) => role.authorize(request as never).success;

describe('the two domains stay separate', () => {
  it('is built on two different access-control instances', () => {
    expect(organizationAccessControl).not.toBe(globalAccessControl);
  });

  it('shares no role object between the domains', () => {
    expect(organizationRoles.admin).not.toBe(globalRoles.admin);
  });

  it('keeps the vocabularies disjoint apart from the word "admin"', () => {
    expect(Object.keys(globalRoles).sort()).toEqual([
      'admin',
      'super_admin',
      'user',
    ]);
    expect(Object.keys(organizationRoles).sort()).toEqual([
      'admin',
      'member',
      'owner',
    ]);

    expect(globalRoles).not.toHaveProperty('owner');
    expect(organizationRoles).not.toHaveProperty('super_admin');
  });
});

describe('the global catalogue tracks the installed plugin', () => {
  it('takes user and session statements from Better Auth itself', () => {
    expect(GLOBAL_PERMISSION_STATEMENTS.user).toEqual(defaultStatements.user);
    expect(GLOBAL_PERMISSION_STATEMENTS.session).toEqual(
      defaultStatements.session,
    );
  });

  it('adds the two statements the application owns', () => {
    expect(GLOBAL_PERMISSION_STATEMENTS.accountLifecycle).toEqual([
      'deactivate',
      'restore',
    ]);
    expect(GLOBAL_PERMISSION_STATEMENTS.organizationLifecycle).toEqual([
      'restore',
    ]);
  });
});

describe('global roles', () => {
  it('grants an ordinary user nothing', () => {
    expect(allows(globalRoles.user, { user: ['list'] })).toBe(false);
    expect(allows(globalRoles.user, { session: ['list'] })).toBe(false);
  });

  it.each([
    ['user:list', { user: ['list'] }],
    ['user:ban', { user: ['ban'] }],
    ['session:revoke', { session: ['revoke'] }],
  ])('grants an admin %s', (_name, request) => {
    expect(allows(globalRoles.admin, request)).toBe(true);
  });

  it.each([
    ['user:set-role', { user: ['set-role'] }],
    ['user:set-password', { user: ['set-password'] }],
    ['user:impersonate-admins', { user: ['impersonate-admins'] }],
    ['accountLifecycle:deactivate', { accountLifecycle: ['deactivate'] }],
    ['organizationLifecycle:restore', { organizationLifecycle: ['restore'] }],
  ])('reserves %s to super_admin', (_name, request) => {
    expect(allows(globalRoles.admin, request)).toBe(false);
    expect(allows(globalRoles.super_admin, request)).toBe(true);
  });

  it('grants user:delete to nobody at all', () => {
    for (const role of Object.values(globalRoles)) {
      expect(allows(role, { user: ['delete'] })).toBe(false);
    }
  });

  it('makes super_admin a superset of admin', () => {
    for (const [resource, actions] of Object.entries(
      GLOBAL_PERMISSION_STATEMENTS,
    )) {
      for (const action of actions) {
        const request = { [resource]: [action] };

        if (allows(globalRoles.admin, request)) {
          expect(allows(globalRoles.super_admin, request)).toBe(true);
        }
      }
    }
  });
});

const MEMBER_GRANTS: ReadonlyArray<[string, string]> = [
  ['knowledge', 'read'],
  ['contentIdea', 'read'],
  ['contentProject', 'read'],
  ['agentActionApproval', 'read'],
];

describe('organization roles', () => {
  it('holds only the grants a member is meant to have', () => {
    for (const [resource, actions] of Object.entries(
      ORGANIZATION_PERMISSION_STATEMENTS,
    )) {
      for (const action of actions) {
        const granted = MEMBER_GRANTS.some(
          ([grantedResource, grantedAction]) =>
            grantedResource === resource && grantedAction === action,
        );

        expect(allows(organizationRoles.member, { [resource]: [action] })).toBe(
          granted,
        );
      }
    }
  });

  it('lets a member read the knowledge base but not change it', () => {
    expect(allows(organizationRoles.member, { knowledge: ['read'] })).toBe(
      true,
    );
    expect(allows(organizationRoles.member, { knowledge: ['write'] })).toBe(
      false,
    );
  });

  it.each([
    ['organization:update', { organization: ['update'] }],
    ['member:create', { member: ['create'] }],
    ['invitation:create', { invitation: ['create'] }],
    ['invitation:cancel', { invitation: ['cancel'] }],
  ])('grants an organization admin %s', (_name, request) => {
    expect(allows(organizationRoles.admin, request)).toBe(true);
  });

  it('reserves mcpSession:create to the roles that manage the organization', () => {
    const request = { mcpSession: ['create'] };

    expect(allows(organizationRoles.member, request)).toBe(false);
    expect(allows(organizationRoles.admin, request)).toBe(true);
    expect(allows(organizationRoles.owner, request)).toBe(true);
  });

  it.each([
    ['organization:archive', { organization: ['archive'] }],
    ['organization:restore', { organization: ['restore'] }],
  ])('reserves %s to the owner', (_name, request) => {
    expect(allows(organizationRoles.member, request)).toBe(false);
    expect(allows(organizationRoles.admin, request)).toBe(false);
    expect(allows(organizationRoles.owner, request)).toBe(true);
  });

  it('grants organization:delete to nobody', () => {
    expect(ORGANIZATION_PERMISSION_STATEMENTS.organization).toContain('delete');

    for (const role of Object.values(organizationRoles)) {
      expect(allows(role, { organization: ['delete'] })).toBe(false);
    }
  });

  it('describes no team or dynamic-role statements', () => {
    expect(ORGANIZATION_PERMISSION_STATEMENTS).not.toHaveProperty('team');
    expect(ORGANIZATION_PERMISSION_STATEMENTS).not.toHaveProperty('ac');
  });
});

describe('role-name guards', () => {
  it('recognises only the names in each map', () => {
    expect(isGlobalRoleName('super_admin')).toBe(true);
    expect(isGlobalRoleName('owner')).toBe(false);
    expect(isGlobalRoleName(undefined)).toBe(false);

    expect(isOrganizationRoleName('owner')).toBe(true);
    expect(isOrganizationRoleName('super_admin')).toBe(false);
  });
});

/**
 * This UI only predicts what the API will allow, and the prediction is only
 * worth anything if it is made from the same policy the API enforces. The
 * backend runs this same comparison against this same shared table, so a
 * hand-edit on either side fails here rather than drifting quietly into a
 * screen that offers something the API refuses.
 */
describe('the predicted policy is the shared policy', () => {
  const grantsFor = (grants: unknown, resource: string): readonly string[] =>
    (grants as Record<string, readonly string[]>)[resource] ?? [];

  it('predicts every global permission exactly as the shared table says', () => {
    for (const roleName of Object.keys(globalRoles) as Array<
      keyof typeof globalRoles
    >) {
      const grants = GLOBAL_ROLE_GRANTS[roleName];

      for (const [resource, actions] of Object.entries(
        GLOBAL_PERMISSION_STATEMENTS,
      )) {
        for (const action of actions) {
          expect(allows(globalRoles[roleName], { [resource]: [action] })).toBe(
            grantsFor(grants, resource).includes(action),
          );
        }
      }
    }
  });

  it('predicts every organization permission exactly as the shared table says', () => {
    for (const roleName of Object.keys(organizationRoles) as Array<
      keyof typeof organizationRoles
    >) {
      const grants = ORGANIZATION_ROLE_GRANTS[roleName];

      for (const [resource, actions] of Object.entries(
        ORGANIZATION_PERMISSION_STATEMENTS,
      )) {
        for (const action of actions) {
          expect(
            allows(organizationRoles[roleName], { [resource]: [action] }),
          ).toBe(grantsFor(grants, resource).includes(action));
        }
      }
    }
  });

  it('covers the same role names the shared table declares', () => {
    expect(Object.keys(globalRoles)).toEqual(Object.keys(GLOBAL_ROLE_GRANTS));
    expect(Object.keys(organizationRoles)).toEqual(
      Object.keys(ORGANIZATION_ROLE_GRANTS),
    );
  });
});
