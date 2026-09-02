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
    // Structural, not conventional: an organization permission cannot be
    // passed where a platform one belongs, because they are not the same
    // catalogue.
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
    // Not a hand-copied list: the admin plugin's routes check these exact
    // strings, so a copy would drift on the next upgrade.
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
    // Matches the backend, where no role holds it either. Hard deletion is
    // not an operation this product has, so no button for it may render.
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

/** What an ordinary member may do here. Everything else must be refused. */
const MEMBER_GRANTS: ReadonlyArray<[string, string]> = [
  ['knowledge', 'read'],
  ['contentIdea', 'read'],
  ['contentProject', 'read'],
  ['agentActionApproval', 'read'],
];

describe('organization roles', () => {
  /**
   * Stated over the whole catalog with an allow-list, rather than by probing
   * two resources.
   *
   * These gates decide which controls an operator is shown, so a grant added
   * here but not on the server puts a button on screen that answers 403 —
   * and probing a sample cannot notice a grant nobody thought to probe. The
   * backend's own spec is written in this shape for the same reason; the two
   * lists are maintained together deliberately.
   */
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

  it.each([
    ['organization:archive', { organization: ['archive'] }],
    ['organization:restore', { organization: ['restore'] }],
  ])('reserves %s to the owner', (_name, request) => {
    expect(allows(organizationRoles.member, request)).toBe(false);
    expect(allows(organizationRoles.admin, request)).toBe(false);
    expect(allows(organizationRoles.owner, request)).toBe(true);
  });

  it('grants organization:delete to nobody', () => {
    // In the catalogue because Better Auth's own route checks it; granted to
    // nobody because the server disables that route entirely.
    expect(ORGANIZATION_PERMISSION_STATEMENTS.organization).toContain('delete');

    for (const role of Object.values(organizationRoles)) {
      expect(allows(role, { organization: ['delete'] })).toBe(false);
    }
  });

  it('describes no team or dynamic-role statements', () => {
    // Both are switched off on the server, so their endpoints do not exist
    // and UI built on them could never work.
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
