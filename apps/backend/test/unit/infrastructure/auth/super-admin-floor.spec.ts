import { describe, expect, it, jest } from '@jest/globals';

import type { PrismaService } from '../../../../src/infrastructure/database';
import { SUPER_ADMIN_GUARDED_PATHS } from '../../../../src/infrastructure/auth/auth-hooks';
import {
  SUPER_ADMIN_FLOOR_SENTINEL,
  isSuperAdminFloorViolation,
  isUsableSuperAdmin,
  wouldEmptySuperAdmins,
} from '../../../../src/infrastructure/auth/super-admin-floor';

/**
 * The definition of "usable", and the paths that have to consult it.
 *
 * The concurrency guarantee is not here and cannot be: it is a property of the
 * database trigger, and asserting it needs two real transactions racing against
 * a real PostgreSQL — which `test/e2e/super-admin-floor.e2e-spec.ts` does. What
 * this file covers is the single-actor decision and the shape of the guard
 * table, both of which are pure functions of a row.
 */

type Row = {
  id: string;
  role: string | null;
  banned: boolean | null;
  deletedAt: Date | null;
};

const admin = (overrides: Partial<Row> = {}): Row => ({
  id: 'user_1',
  role: 'super_admin',
  banned: false,
  deletedAt: null,
  ...overrides,
});

const prismaOver = (rows: Row[]) =>
  ({
    user: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(rows.find((row) => row.id === where.id) ?? null),
      ),
      findMany: jest.fn(
        ({ where }: { where: { role: { contains: string } } }) =>
          Promise.resolve(
            rows.filter((row) => row.role?.includes(where.role.contains)),
          ),
      ),
    },
  }) as unknown as PrismaService;

describe('isUsableSuperAdmin', () => {
  it('accepts a super administrator who could sign in', () => {
    expect(isUsableSuperAdmin(admin())).toBe(true);
  });

  /**
   * The three ways a row can hold the role and still be nobody.
   *
   * This is the whole reason the invariant is not `count(role = 'super_admin')`:
   * a banned account cannot authenticate and a deactivated one is refused a
   * session, so either satisfies a naive count while leaving the platform with
   * nobody able to appoint a replacement.
   */
  it.each([
    ['banned', admin({ banned: true })],
    ['deactivated', admin({ deletedAt: new Date() })],
    ['not a super administrator', admin({ role: 'admin' })],
    ['holding no role at all', admin({ role: null })],
  ])('refuses one who is %s', (unusedName, row) => {
    expect(isUsableSuperAdmin(row)).toBe(false);
  });

  /**
   * Roles are comma-separated, so membership is a split rather than a substring
   * test. `role.includes('super_admin')` would accept a role literally named
   * `not_super_admin`, which is a made-up example — but `deputy_super_admin` is
   * not, and either would silently count toward the floor.
   */
  it('reads a comma-separated role list rather than searching the string', () => {
    expect(isUsableSuperAdmin(admin({ role: 'user,super_admin' }))).toBe(true);
    expect(isUsableSuperAdmin(admin({ role: ' super_admin , user ' }))).toBe(
      true,
    );
    expect(isUsableSuperAdmin(admin({ role: 'not_super_admin' }))).toBe(false);
    expect(isUsableSuperAdmin(admin({ role: 'super_administrator' }))).toBe(
      false,
    );
  });
});

describe('wouldEmptySuperAdmins', () => {
  it('is true for the only usable super administrator', async () => {
    await expect(
      wouldEmptySuperAdmins(prismaOver([admin({ id: 'only' })]), 'only'),
    ).resolves.toBe(true);
  });

  it('is false when another usable one remains', async () => {
    const rows = [admin({ id: 'first' }), admin({ id: 'second' })];

    await expect(
      wouldEmptySuperAdmins(prismaOver(rows), 'first'),
    ).resolves.toBe(false);
  });

  /**
   * A second row holding the role is not a second administrator.
   *
   * This is the case a row count gets wrong, and the one that produces the
   * lockout in practice: an operator demotes themselves believing a colleague
   * still holds the role, when that colleague's account was banned months ago.
   */
  it.each([
    ['banned', admin({ id: 'second', banned: true })],
    ['deactivated', admin({ id: 'second', deletedAt: new Date() })],
  ])('is true when the only other one is %s', async (unusedName, other) => {
    await expect(
      wouldEmptySuperAdmins(
        prismaOver([admin({ id: 'first' }), other]),
        'first',
      ),
    ).resolves.toBe(true);
  });

  /** Nothing to protect: the account is not counted toward the floor. */
  it.each([
    ['an ordinary user', admin({ id: 'target', role: 'user' })],
    ['an already-banned administrator', admin({ id: 'target', banned: true })],
  ])('is false for %s', async (unusedName, target) => {
    await expect(
      wouldEmptySuperAdmins(
        prismaOver([target, admin({ id: 'other' })]),
        'target',
      ),
    ).resolves.toBe(false);
  });

  it('is false for an account that does not exist', async () => {
    await expect(
      wouldEmptySuperAdmins(prismaOver([admin()]), 'nobody'),
    ).resolves.toBe(false);
  });
});

describe('isSuperAdminFloorViolation', () => {
  it('recognises the trigger by its sentinel', () => {
    expect(
      isSuperAdminFloorViolation(
        new Error(
          `ERROR: ${SUPER_ADMIN_FLOOR_SENTINEL}: the platform must keep…`,
        ),
      ),
    ).toBe(true);
  });

  it.each([
    ['an unrelated database error', new Error('duplicate key value')],
    ['a non-error', 'super_admin_floor_violation'],
    ['nothing', undefined],
  ])('does not claim %s', (unusedName, thrown) => {
    expect(isSuperAdminFloorViolation(thrown)).toBe(false);
  });
});

describe('SUPER_ADMIN_GUARDED_PATHS', () => {
  /**
   * The two routes that are the same operation under different names.
   *
   * `/admin/update-user` writes arbitrary user-schema fields, `role` and
   * `banned` among them, so guarding only `/admin/set-role` and
   * `/admin/ban-user` would leave a third door to both. Named individually so
   * the failure says which one went missing.
   */
  it.each([
    '/admin/set-role',
    '/admin/ban-user',
    '/admin/remove-user',
    '/admin/update-user',
  ])('guards %s', (path) => {
    expect(SUPER_ADMIN_GUARDED_PATHS[path]).toBeDefined();
  });

  /**
   * And the routes it deliberately leaves alone. A guard that refused these
   * would be refusing operations the invariant has no interest in — a changed
   * password is still a password.
   */
  it.each([
    '/admin/set-user-password',
    '/admin/impersonate-user',
    '/admin/list-users',
  ])('does not guard %s', (path) => {
    expect(SUPER_ADMIN_GUARDED_PATHS[path]).toBeUndefined();
  });
});
