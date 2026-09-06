import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import type { ConfigType } from '@nestjs/config';

import type { databaseConfig } from '../../../src/infrastructure/config';
import type { PrismaService } from '../../../src/infrastructure/database';
import type {
  AdminUserApi,
  PasswordPolicy,
} from '../../../src/cli/admin-user-api';
import type { BootstrapLock } from '../../../src/cli/bootstrap-lock';

const acquireBootstrapLock =
  jest.fn<
    (
      connectionString: string,
      connectionTimeoutMillis: number,
    ) => Promise<BootstrapLock | undefined>
  >();

jest.unstable_mockModule('../../../src/cli/bootstrap-lock', () => ({
  acquireBootstrapLock,
}));

let SuperAdminBootstrap: typeof import('../../../src/cli/super-admin.bootstrap').SuperAdminBootstrap;

beforeAll(async () => {
  ({ SuperAdminBootstrap } =
    await import('../../../src/cli/super-admin.bootstrap'));
});

const PASSWORD = 'CANARY-P4ssw0rd-do-not-log';

const POLICY: PasswordPolicy = { minLength: 10, maxLength: 40 };

const REQUEST = {
  email: 'ops@example.com',
  name: 'Ops',
  password: PASSWORD,
};

const database: ConfigType<typeof databaseConfig> = {
  url: 'postgresql://bootstrap-spec/unused',
  connectTimeoutMs: 5_000,
};

describe('SuperAdminBootstrap', () => {
  const findMany =
    jest.fn<(args?: unknown) => Promise<{ role: string | null }[]>>();
  const findUnique = jest.fn<
    (args?: unknown) => Promise<{
      id: string;
      role?: string | null;
      accounts?: { id: string }[];
    } | null>
  >();
  const deleteUser = jest.fn<(args?: unknown) => Promise<{ id: string }>>();
  const createUser = jest.fn<AdminUserApi['createUser']>();
  const release = jest.fn<() => Promise<void>>();

  const prisma = {
    user: { findMany, findUnique, delete: deleteUser },
  } as unknown as PrismaService;

  const bootstrap = (policy: PasswordPolicy = POLICY) =>
    new SuperAdminBootstrap(prisma, { createUser }, policy, database);

  const passwordOfLength = (length: number) => 'p'.repeat(length);

  beforeEach(() => {
    findMany.mockReset().mockResolvedValue([]);
    findUnique.mockReset().mockResolvedValue(null);
    createUser
      .mockReset()
      .mockResolvedValue({ user: { id: 'user-1', email: 'ops@example.com' } });
    deleteUser.mockReset().mockResolvedValue({ id: 'user-1' });
    release.mockReset().mockResolvedValue();
    acquireBootstrapLock.mockReset().mockResolvedValue({ release });
  });

  describe('countSuperAdmins', () => {
    it.each([
      ['the role on its own', 'super_admin'],
      ['the role among others', 'admin,super_admin'],
      ['the role first', 'super_admin,user'],
      ['the role padded with spaces', 'admin, super_admin , user'],
    ])('counts a user with %s', async (_label, role) => {
      findMany.mockResolvedValue([{ role }]);

      await expect(bootstrap().countSuperAdmins()).resolves.toBe(1);
    });

    it.each([
      ['a longer role that starts with it', 'super_administrator'],
      ['a longer role that ends with it', 'x_super_admin'],
      ['a longer role that contains it', 'not_super_admin_x'],
      ['an unrelated role', 'user'],
      ['no role at all', null],
      ['an empty role', ''],
    ])('does not count %s', async (_label, role) => {
      findMany.mockResolvedValue([{ role }]);

      await expect(bootstrap().countSuperAdmins()).resolves.toBe(0);
    });

    it('counts every holder in a mixed set', async () => {
      findMany.mockResolvedValue([
        { role: 'super_admin' },
        { role: 'admin,super_admin' },
        { role: 'super_administrator' },
        { role: 'user' },
        { role: null },
      ]);

      await expect(bootstrap().countSuperAdmins()).resolves.toBe(2);
    });

    it('narrows the query to candidate rows and reads only the role', async () => {
      await bootstrap().countSuperAdmins();

      expect(findMany).toHaveBeenCalledWith({
        where: { role: { contains: 'super_admin' } },
        select: { role: true },
      });
    });

    it('does not exclude deactivated or banned holders of the role', async () => {
      await bootstrap().countSuperAdmins();

      const where = (
        findMany.mock.calls[0][0] as { where: Record<string, unknown> }
      ).where;

      expect(Object.keys(where)).toEqual(['role']);
    });
  });

  describe('run', () => {
    it('creates the account through Better Auth and reports the new user', async () => {
      await expect(bootstrap().run(REQUEST)).resolves.toEqual({
        status: 'created',
        userId: 'user-1',
        email: 'ops@example.com',
      });
    });

    it('requests the super_admin role, a verified address, and the exact password', async () => {
      await bootstrap().run(REQUEST);

      expect(createUser).toHaveBeenCalledWith({
        body: {
          email: 'ops@example.com',
          name: 'Ops',
          password: PASSWORD,
          role: 'super_admin',
          data: { emailVerified: true },
        },
      });
    });

    it('refuses and creates nothing when a super administrator exists', async () => {
      findMany.mockResolvedValue([{ role: 'admin,super_admin' }]);

      await expect(bootstrap().run(REQUEST)).resolves.toEqual({
        status: 'already-bootstrapped',
        existingCount: 1,
      });

      expect(createUser).not.toHaveBeenCalled();
    });

    it('reports the lock rather than waiting for it', async () => {
      acquireBootstrapLock.mockResolvedValue(undefined);

      await expect(bootstrap().run(REQUEST)).resolves.toEqual({
        status: 'locked',
      });

      expect(findMany).not.toHaveBeenCalled();
      expect(createUser).not.toHaveBeenCalled();
    });

    it('reports a taken email without attempting the write', async () => {
      findUnique.mockResolvedValue({ id: 'existing-user' });

      await expect(bootstrap().run(REQUEST)).resolves.toEqual({
        status: 'email-taken',
      });

      expect(findUnique).toHaveBeenCalledWith({
        where: { email: 'ops@example.com' },
        select: { id: true },
      });
      expect(createUser).not.toHaveBeenCalled();
    });

    it('takes the lock on the configured database, with a bounded connect', async () => {
      await bootstrap().run(REQUEST);

      expect(acquireBootstrapLock).toHaveBeenCalledWith(
        database.url,
        database.connectTimeoutMs,
      );
    });

    describe('the configured password policy', () => {
      it.each([
        ['one character', 1],
        ['one below the minimum', POLICY.minLength - 1],
      ])('refuses a password of %s', async (_label, length) => {
        await expect(
          bootstrap().run({ ...REQUEST, password: passwordOfLength(length) }),
        ).resolves.toEqual({
          status: 'password-rejected',
          minLength: POLICY.minLength,
          maxLength: POLICY.maxLength,
        });
      });

      it('refuses a password one above the maximum', async () => {
        await expect(
          bootstrap().run({
            ...REQUEST,
            password: passwordOfLength(POLICY.maxLength + 1),
          }),
        ).resolves.toEqual({
          status: 'password-rejected',
          minLength: POLICY.minLength,
          maxLength: POLICY.maxLength,
        });
      });

      it.each([
        ['exactly the minimum', POLICY.minLength],
        ['exactly the maximum', POLICY.maxLength],
      ])('accepts a password of %s', async (_label, length) => {
        await expect(
          bootstrap().run({ ...REQUEST, password: passwordOfLength(length) }),
        ).resolves.toMatchObject({ status: 'created' });
      });

      it('refuses without taking the lock or attempting the write', async () => {
        await bootstrap().run({ ...REQUEST, password: 'short' });

        expect(acquireBootstrapLock).not.toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
        expect(findMany).not.toHaveBeenCalled();
        expect(createUser).not.toHaveBeenCalled();
      });

      it('applies whichever bounds the deployment reported', async () => {
        const strict: PasswordPolicy = { minLength: 64, maxLength: 72 };

        await expect(
          bootstrap(strict).run({ ...REQUEST, password: passwordOfLength(32) }),
        ).resolves.toEqual({
          status: 'password-rejected',
          minLength: 64,
          maxLength: 72,
        });
      });
    });

    describe('after a failed creation', () => {
      const failure = new Error('connection terminated unexpectedly');

      beforeEach(() => {
        createUser.mockRejectedValue(failure);
      });

      it('deletes the role-bearing row that has no credential', async () => {
        findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
          id: 'orphan-1',
          role: 'super_admin',
          accounts: [],
        });

        await expect(bootstrap().run(REQUEST)).rejects.toThrow(failure);

        expect(deleteUser).toHaveBeenCalledWith({ where: { id: 'orphan-1' } });
      });

      it('rethrows the original failure rather than the cleanup outcome', async () => {
        findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
          id: 'orphan-1',
          role: 'super_admin',
          accounts: [],
        });

        await expect(bootstrap().run(REQUEST)).rejects.toBe(failure);
      });

      it('leaves a row that does have a credential alone', async () => {
        findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
          id: 'user-1',
          accounts: [{ id: 'acct-1' }],
        });

        await expect(bootstrap().run(REQUEST)).rejects.toThrow(failure);

        expect(deleteUser).not.toHaveBeenCalled();
      });

      it('leaves a credential-less row that does not hold the role', async () => {
        findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
          id: 'stranger-1',
          role: 'user',
          accounts: [],
        });

        await expect(bootstrap().run(REQUEST)).rejects.toThrow(failure);

        expect(deleteUser).not.toHaveBeenCalled();
      });

      it('leaves a credential-less row with no role', async () => {
        findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
          id: 'stranger-2',
          role: null,
          accounts: [],
        });

        await expect(bootstrap().run(REQUEST)).rejects.toThrow(failure);

        expect(deleteUser).not.toHaveBeenCalled();
      });

      it('does nothing when no row was written at all', async () => {
        findUnique.mockResolvedValue(null);

        await expect(bootstrap().run(REQUEST)).rejects.toThrow(failure);

        expect(deleteUser).not.toHaveBeenCalled();
      });

      it('does not let a failed orphan lookup mask the original error', async () => {
        findUnique
          .mockResolvedValueOnce(null)
          .mockRejectedValueOnce(new Error('lookup failed'));

        await expect(bootstrap().run(REQUEST)).rejects.toBe(failure);
      });

      it('does not let a failed delete mask the original error', async () => {
        findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
          id: 'orphan-1',
          role: 'super_admin',
          accounts: [],
        });
        deleteUser.mockRejectedValue(new Error('delete failed'));

        await expect(bootstrap().run(REQUEST)).rejects.toBe(failure);
        expect(deleteUser).toHaveBeenCalledTimes(1);
      });

      it('still releases the lock', async () => {
        findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
          id: 'orphan-1',
          role: 'super_admin',
          accounts: [],
        });

        await expect(bootstrap().run(REQUEST)).rejects.toThrow(failure);

        expect(release).toHaveBeenCalledTimes(1);
      });
    });

    describe('releases the lock', () => {
      it('after creating the account', async () => {
        await bootstrap().run(REQUEST);

        expect(release).toHaveBeenCalledTimes(1);
      });

      it('after refusing an already-bootstrapped platform', async () => {
        findMany.mockResolvedValue([{ role: 'super_admin' }]);

        await bootstrap().run(REQUEST);

        expect(release).toHaveBeenCalledTimes(1);
      });

      it('after refusing a taken email', async () => {
        findUnique.mockResolvedValue({ id: 'existing-user' });

        await bootstrap().run(REQUEST);

        expect(release).toHaveBeenCalledTimes(1);
      });

      it('when the account creation throws', async () => {
        createUser.mockRejectedValue(new Error('password too short'));

        await expect(bootstrap().run(REQUEST)).rejects.toThrow(
          'password too short',
        );

        expect(release).toHaveBeenCalledTimes(1);
      });

      it('when the existing-administrator query throws', async () => {
        findMany.mockRejectedValue(new Error('connection terminated'));

        await expect(bootstrap().run(REQUEST)).rejects.toThrow(
          'connection terminated',
        );

        expect(release).toHaveBeenCalledTimes(1);
      });
    });
  });
});
