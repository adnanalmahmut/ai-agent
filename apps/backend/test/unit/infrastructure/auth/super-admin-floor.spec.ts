import { describe, expect, it, jest } from '@jest/globals';

import type { PrismaService } from '../../../../src/infrastructure/database';
import { SUPER_ADMIN_GUARDED_PATHS } from '../../../../src/infrastructure/auth/auth-hooks';
import {
  SUPER_ADMIN_FLOOR_SENTINEL,
  isSuperAdminFloorViolation,
  isUsableSuperAdmin,
  wouldEmptySuperAdmins,
} from '../../../../src/infrastructure/auth/super-admin-floor';

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

  it.each([
    ['banned', admin({ banned: true })],
    ['deactivated', admin({ deletedAt: new Date() })],
    ['not a super administrator', admin({ role: 'admin' })],
    ['holding no role at all', admin({ role: null })],
  ])('refuses one who is %s', (unusedName, row) => {
    expect(isUsableSuperAdmin(row)).toBe(false);
  });

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
  it.each([
    '/admin/set-role',
    '/admin/ban-user',
    '/admin/remove-user',
    '/admin/update-user',
  ])('guards %s', (path) => {
    expect(SUPER_ADMIN_GUARDED_PATHS[path]).toBeDefined();
  });

  it.each([
    '/admin/set-user-password',
    '/admin/impersonate-user',
    '/admin/list-users',
  ])('does not guard %s', (path) => {
    expect(SUPER_ADMIN_GUARDED_PATHS[path]).toBeUndefined();
  });
});
