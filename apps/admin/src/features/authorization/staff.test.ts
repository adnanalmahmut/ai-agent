import { GLOBAL_ROLE_GRANTS } from '@repo/authz-policy';
import { describe, expect, it } from 'vitest';

import { STAFF_ROLE_NAMES, isStaffPrincipal, isStaffRole } from './staff';

/**
 * The predicate the whole workspace hangs off. Every case that is not a
 * recognised staff claim has to come back false, so the tests are written as
 * a denial list rather than as a happy path with exceptions.
 */

describe('who the shared policy makes staff', () => {
  it('reads the staff roles off the policy rather than a list of its own', () => {
    // Derived, not declared: a role added to the policy is classified by what
    // it can do. `user` holds no platform-wide action and is not staff.
    expect(STAFF_ROLE_NAMES).toEqual(['admin', 'super_admin']);
    expect(Object.keys(GLOBAL_ROLE_GRANTS)).toContain('user');
  });

  it.each(['admin', 'super_admin'])('admits %s', (role) => {
    expect(isStaffRole(role)).toBe(true);
  });

  it('does not admit an ordinary account', () => {
    expect(isStaffRole('user')).toBe(false);
  });

  it('admits a comma-separated claim that contains a staff role', () => {
    expect(isStaffRole('user,admin')).toBe(true);
    expect(isStaffRole(' admin , user ')).toBe(true);
  });

  it('refuses the whole claim when one name is not in the policy', () => {
    // An unevaluable claim is not a claim to act on, so an unknown name
    // denies rather than being skipped over.
    expect(isStaffRole('admin,operator')).toBe(false);
    expect(isStaffRole('operator')).toBe(false);
  });

  it.each([
    ['nothing at all', undefined],
    ['null', null],
    ['an empty string', ''],
    ['whitespace', '   '],
    ['a list of separators', ',,,'],
    ['a number', 7],
    ['an object', { role: 'admin' }],
    ['an array', ['admin']],
    ['a truthy non-role', true],
  ])('denies %s', (_case, role) => {
    expect(isStaffRole(role)).toBe(false);
  });

  it('is case-sensitive, because the policy is', () => {
    expect(isStaffRole('Admin')).toBe(false);
    expect(isStaffRole('SUPER_ADMIN')).toBe(false);
  });
});

describe('the principal behind a session', () => {
  it('admits a staff account in good standing', () => {
    expect(isStaffPrincipal({ id: 'u1', role: 'admin' })).toBe(true);
  });

  it('refuses a suspended staff account', () => {
    // A ban leaves the role in place. It does not leave the access in place.
    expect(isStaffPrincipal({ id: 'u1', role: 'admin', banned: true })).toBe(
      false,
    );
  });

  it('ignores a ban flag that is absent or false', () => {
    expect(isStaffPrincipal({ id: 'u1', role: 'admin', banned: false })).toBe(
      true,
    );
    expect(isStaffPrincipal({ id: 'u1', role: 'admin', banned: null })).toBe(
      true,
    );
  });

  it.each([
    ['no user', undefined],
    ['null', null],
    ['an empty object', {}],
    ['a user with no role', { id: 'u1' }],
    ['a user with a null role', { id: 'u1', role: null }],
    ['a string', 'admin'],
  ])('denies %s', (_case, user) => {
    expect(isStaffPrincipal(user)).toBe(false);
  });

  it('never grants because something was missing', () => {
    // The shape of the rule matters as much as the cases: there is no branch
    // that reads an absent value as permission.
    const permissive = [undefined, null, {}, { role: '' }, { banned: false }];

    expect(permissive.map(isStaffPrincipal)).toEqual(permissive.map(() => false));
  });
});
