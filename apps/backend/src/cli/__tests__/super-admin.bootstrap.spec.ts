import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import type { ConfigType } from '@nestjs/config';

import type { databaseConfig } from '../../config';
import type { PrismaService } from '../../database';
import type { AdminUserApi, PasswordPolicy } from '../admin-user-api';
import type { BootstrapLock } from '../bootstrap-lock';

/**
 * The one privilege escalation this platform performs with no authenticated
 * actor, and the three conditions that are all that stand between it and a
 * second one.
 *
 * The lock is mocked because what is under test is the decision sequence, not
 * PostgreSQL: whether the count is read correctly, whether a positive count
 * stops the write, and whether the connection holding the lock is given back on
 * every exit. The lock's actual mutual exclusion is proved against a real
 * database in `test/e2e/super-admin-cli.e2e-spec.ts`, which is the only place
 * it can be.
 */

const acquireBootstrapLock =
  jest.fn<
    (
      connectionString: string,
      connectionTimeoutMillis: number,
    ) => Promise<BootstrapLock | undefined>
  >();

jest.unstable_mockModule('../bootstrap-lock', () => ({ acquireBootstrapLock }));

let SuperAdminBootstrap: typeof import('../super-admin.bootstrap').SuperAdminBootstrap;

beforeAll(async () => {
  ({ SuperAdminBootstrap } = await import('../super-admin.bootstrap'));
});

/** A canary rather than a plausible password: it is asserted byte for byte. */
const PASSWORD = 'CANARY-P4ssw0rd-do-not-log';

/**
 * Deliberately not Better Auth's real 8/128. The bounds are read from the live
 * configuration at runtime, so a spec that reused the real numbers could not
 * tell "applies the configured policy" apart from "restates a default" — which
 * is the exact mistake this check exists to avoid.
 */
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

  /** A password of an exact length, so the boundary cases read as their point. */
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

  /**
   * Better Auth stores roles as one comma-separated string, so the only way to
   * ask "does this user hold `super_admin`" is to split it. A substring test
   * would be right until the day the catalogue gains a role whose name contains
   * this one — and the failure would be a bootstrap command that refuses
   * forever on a platform that has no super administrator at all, or, in the
   * other direction, a second owner created on a platform that already has one.
   */
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

    /**
     * The `contains` filter is a prefilter that lets PostgreSQL discard most
     * rows; it is deliberately not the decision, which is why the rows it
     * returns are re-examined above.
     */
    it('narrows the query to candidate rows and reads only the role', async () => {
      await bootstrap().countSuperAdmins();

      expect(findMany).toHaveBeenCalledWith({
        where: { role: { contains: 'super_admin' } },
        select: { role: true },
      });
    });

    /**
     * The gate counts *every* holder of the role, including ones the platform
     * currently refuses to let in.
     *
     * A `deletedAt: null` or `banned: false` filter reads like hygiene and is
     * the most dangerous change available to this file. Deactivation is a soft
     * delete and a ban is a moderation state — both are reversible, and both
     * leave the account and its credential intact. Excluding either would let
     * anyone who can reach this command mint a brand-new root account on a
     * platform that already has an owner, simply by deactivating or banning the
     * existing one first, and the platform would look correctly bootstrapped
     * throughout.
     *
     * Asserted on the shape of the `where` clause rather than on rows, because
     * the fake would answer whatever it was told; the filter itself is the
     * thing that must not appear. The live consequence is pinned in the e2e
     * suite against real soft-deleted and banned rows.
     */
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

    /**
     * Every field matters and each one fails differently if it is dropped: the
     * role is the entire point, `emailVerified` is what makes the account
     * usable at all — sign-in requires it and the verification mail has nowhere
     * to go on a platform being bootstrapped — and the password must arrive at
     * the configured hasher exactly as it was typed, or the operator is locked
     * out of the account they just created.
     */
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

    /**
     * The command works exactly once. After that the answer is permanently
     * "no", and granting the role becomes an authorized operation performed by
     * someone who already holds it — so the write must not be attempted at all,
     * not merely rejected downstream.
     */
    it('refuses and creates nothing when a super administrator exists', async () => {
      findMany.mockResolvedValue([{ role: 'admin,super_admin' }]);

      await expect(bootstrap().run(REQUEST)).resolves.toEqual({
        status: 'already-bootstrapped',
        existingCount: 1,
      });

      expect(createUser).not.toHaveBeenCalled();
    });

    /**
     * Told, not queued. A second operator waiting silently behind the first
     * would be told "already bootstrapped" a moment later and would have no way
     * to tell that from a platform that was set up last year.
     */
    it('reports the lock rather than waiting for it', async () => {
      acquireBootstrapLock.mockResolvedValue(undefined);

      await expect(bootstrap().run(REQUEST)).resolves.toEqual({
        status: 'locked',
      });

      expect(findMany).not.toHaveBeenCalled();
      expect(createUser).not.toHaveBeenCalled();
    });

    /**
     * Distinguished from `already-bootstrapped` on purpose: "that address is
     * taken" and "this platform already has an owner" call for different next
     * steps, and Better Auth's own duplicate rejection would say neither.
     */
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

    /**
     * The lock has to be taken against the database that is being written, and
     * with a bounded connect timeout. Unbounded is `node-postgres`'s default
     * and means wait forever: an unreachable database would hang the command
     * with the plaintext password resident in the heap rather than failing.
     */
    it('takes the lock on the configured database, with a bounded connect', async () => {
      await bootstrap().run(REQUEST);

      expect(acquireBootstrapLock).toHaveBeenCalledWith(
        database.url,
        database.connectTimeoutMs,
      );
    });

    /**
     * The length rule Better Auth does not apply.
     *
     * Verified against 1.6.27: the admin plugin's `createUser` goes from insert
     * straight to hash and never reads `minPasswordLength`, so the single
     * endpoint that mints the platform's most privileged account — the one
     * nobody can reset, the one that is not rate limited because it is not
     * reachable over HTTP — was the only one enforcing nothing. A one-character
     * root password was fully usable.
     *
     * The bounds come from the live configuration rather than from constants
     * here, so this stays one opinion rather than two; these tests use bounds
     * that are deliberately not the deployment's, so a regression to hard-coded
     * defaults fails them.
     */
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

      /**
       * The maximum is a real rule, not a formality: the configured hash has a
       * cost per byte, and an unbounded password is a denial of service the
       * operator inflicts on their own host.
       */
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

      /** Both bounds inclusive; an off-by-one here refuses a legal password. */
      it.each([
        ['exactly the minimum', POLICY.minLength],
        ['exactly the maximum', POLICY.maxLength],
      ])('accepts a password of %s', async (_label, length) => {
        await expect(
          bootstrap().run({ ...REQUEST, password: passwordOfLength(length) }),
        ).resolves.toMatchObject({ status: 'created' });
      });

      /**
       * Refused before the lock, because the verdict depends on the request
       * alone. Taking a database connection and an exclusive advisory lock to
       * answer a question about a string length would make one operator's typo
       * block another operator's real attempt.
       */
      it('refuses without taking the lock or attempting the write', async () => {
        await bootstrap().run({ ...REQUEST, password: 'short' });

        expect(acquireBootstrapLock).not.toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
        expect(findMany).not.toHaveBeenCalled();
        expect(createUser).not.toHaveBeenCalled();
      });

      /** The deployment's numbers, whatever they are, are the ones applied. */
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

    /**
     * The half-created account, which is the worst outcome this feature has.
     *
     * `createUser` is two writes with no transaction: the user row first, then
     * the hash and the credential account. A failure in between — a connection
     * blip is enough — leaves a row holding `super_admin` with nothing to sign
     * in with. `countSuperAdmins` then answers one forever, the command refuses
     * permanently, and the platform cannot be bootstrapped again without
     * someone hand-editing the database. The cleanup is what keeps a transient
     * failure transient.
     */
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

      /**
       * The original error still reaches the operator. A cleanup that swallowed
       * it would report a tidy database and no reason for the failure.
       */
      it('rethrows the original failure rather than the cleanup outcome', async () => {
        findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
          id: 'orphan-1',
          role: 'super_admin',
          accounts: [],
        });

        await expect(bootstrap().run(REQUEST)).rejects.toBe(failure);
      });

      /**
       * The condition is what makes the deletion safe. A row that does have a
       * credential is a usable account — `createUser` failed after both writes,
       * or something else owns the address — and deleting it would turn a
       * failed bootstrap into destroyed data.
       */
      it('leaves a row that does have a credential alone', async () => {
        findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
          id: 'user-1',
          accounts: [{ id: 'acct-1' }],
        });

        await expect(bootstrap().run(REQUEST)).rejects.toThrow(failure);

        expect(deleteUser).not.toHaveBeenCalled();
      });

      /**
       * The row has to be *ours*, and the role is the only evidence of that.
       *
       * The advisory lock excludes other bootstraps; it does not exclude the
       * public sign-up route. Between the email pre-check and the failure, a
       * stranger can register that address — a few seconds is enough — and the
       * "the email was absent moments ago" argument does not reach them.
       * Without the role condition the cleanup would delete a real person's
       * brand-new account, and the sign-up path itself creates the user row
       * before the credential, so the accounts check alone would not save it.
       */
      it('leaves a credential-less row that does not hold the role', async () => {
        findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
          id: 'stranger-1',
          role: 'user',
          accounts: [],
        });

        await expect(bootstrap().run(REQUEST)).rejects.toThrow(failure);

        expect(deleteUser).not.toHaveBeenCalled();
      });

      /** Including a row that has no role at all, which is the plugin default. */
      it('leaves a credential-less row with no role', async () => {
        findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
          id: 'stranger-2',
          role: null,
          accounts: [],
        });

        await expect(bootstrap().run(REQUEST)).rejects.toThrow(failure);

        expect(deleteUser).not.toHaveBeenCalled();
      });

      /** Nothing to clean up is not a failure. */
      it('does nothing when no row was written at all', async () => {
        findUnique.mockResolvedValue(null);

        await expect(bootstrap().run(REQUEST)).rejects.toThrow(failure);

        expect(deleteUser).not.toHaveBeenCalled();
      });

      /**
       * A cleanup that fails must not become the error the operator sees. The
       * database is already misbehaving on this path — that is why the cleanup
       * is running — so its own failure is the least informative thing
       * available, and the residue is a runbook problem rather than a silent
       * substitution of causes.
       */
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

      /** And the lock is still handed back, cleanup or not. */
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

    /**
     * The lock is a session on a dedicated connection, so a path that returns
     * without releasing it leaves a PostgreSQL backend held open and — far
     * worse for a command an operator is about to re-run — blocks every later
     * attempt until the process exits.
     */
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

      /**
       * The path that a `try`/`finally` exists for, and the one a reader is
       * most likely to assume is covered by the others. A rejected
       * `createUser` — a password the configured policy refuses, a database
       * that went away mid-call — must still hand the connection back.
       */
      it('when the account creation throws', async () => {
        createUser.mockRejectedValue(new Error('password too short'));

        await expect(bootstrap().run(REQUEST)).rejects.toThrow(
          'password too short',
        );

        expect(release).toHaveBeenCalledTimes(1);
      });

      /** Including when the count query itself is what failed. */
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
