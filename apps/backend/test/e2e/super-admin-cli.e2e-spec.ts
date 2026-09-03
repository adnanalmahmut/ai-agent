import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { Readable, Writable } from 'node:stream';

import { databaseConfig } from '../../src/infrastructure/config';
import type {
  AdminUserApi,
  PasswordPolicy,
} from '../../src/cli/admin-user-api';
import { PASSWORD_POLICY } from '../../src/cli/admin-user-api';
import { CliModule } from '../../src/cli/cli.module';
import { dispatchCliCommand } from '../../src/cli/dispatch';
import type { BootstrapOutcome } from '../../src/cli/super-admin.bootstrap';
import { SuperAdminBootstrap } from '../../src/cli/super-admin.bootstrap';
import { EXIT, type CommandIo } from '../../src/cli/super-admin.command';
import { MAIL_TRANSPORT } from '../../src/infrastructure/mail/mail-transport';
import {
  as,
  CapturingTransport,
  cookieOf,
  createHarness,
  trySignIn,
  type Harness,
} from '../support/auth-harness';

/**
 * The bootstrap command against a real PostgreSQL and the real Better Auth.
 *
 * Everything the unit tests cannot reach is here, and all of it is the same
 * question: is the account this command writes indistinguishable from one the
 * API would have written? The command deliberately goes through
 * `auth.api.createUser` rather than inserting rows, so the things that can go
 * wrong are the things a fake would have hidden — a password that never reaches
 * the configured hasher, a credential account that is never linked, a role
 * string the catalogue does not accept, an `emailVerified` flag that does not
 * actually satisfy `requireEmailVerification`. Each of those produces an
 * account that looks correct in the database and cannot sign in, which is the
 * worst possible outcome for the one credential nobody can reset.
 *
 * The real `CliModule` is booted rather than the bootstrap being constructed by
 * hand, because the composition root is part of what is under test: it is where
 * the admin plugin's `createUser` is narrowed out of an untyped `auth.api`, and
 * a rename in the library has to fail here rather than in production.
 */

const PREFIX = `super-admin-cli-e2e-${process.pid}`;
const email = (label: string) => `${PREFIX}-${label}@example.test`;

/** Long enough for the configured policy; distinctive enough to grep for. */
const PASSWORD = 'Bootstrap-e2e-P4ssword';

const SUPER_ADMIN = 'super_admin';

/**
 * The role test, written out again rather than imported.
 *
 * This suite has to be able to disagree with the implementation about who holds
 * the role — that is the point of the fixture bookkeeping below — so it does
 * not reuse `hasSuperAdminRole`.
 */
const rolesOf = (role: string | null): string[] =>
  (role ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

describe('super-admin bootstrap CLI (e2e)', () => {
  let harness: Harness;
  let cli: INestApplicationContext;
  let bootstrap: SuperAdminBootstrap;
  let policy: PasswordPolicy;

  /**
   * A bootstrap wired to the real database and the real policy, but to a
   * caller-supplied `createUser`.
   *
   * The only way to reach the orphan-cleanup path is for the account creation
   * to fail *between* Better Auth's two writes, which the real library will not
   * do on request. Substituting that one call — and nothing else — exercises
   * the cleanup against real Prisma, the real relation query and real rows,
   * which is where its safety condition actually lives.
   */
  const bootstrapWith = (adminUsers: AdminUserApi) =>
    new SuperAdminBootstrap(
      harness.prisma,
      adminUsers,
      policy,
      cli.get(databaseConfig.KEY),
    );

  /** Roles this suite temporarily removed, exactly as they were found. */
  let borrowed: { id: string; role: string | null }[] = [];

  const superAdminIds = async (): Promise<string[]> => {
    const candidates = await harness.prisma.user.findMany({
      where: { role: { contains: SUPER_ADMIN } },
      select: { id: true, role: true },
    });

    return candidates
      .filter((candidate) => rolesOf(candidate.role).includes(SUPER_ADMIN))
      .map((candidate) => candidate.id);
  };

  const deleteFixtures = async () => {
    // Accounts and sessions cascade from the user row.
    await harness.prisma.user.deleteMany({
      where: { email: { startsWith: PREFIX } },
    });
  };

  /**
   * Runs one block with the super-administrator floor suspended.
   *
   * The database refuses an UPDATE that would leave no usable super
   * administrator — which is the invariant, working. This suite's whole
   * premise is the state that invariant forbids: the bootstrap command runs
   * only when the platform has none, and reaching that state on a shared test
   * database means stripping the role from every account that holds it.
   *
   * So the floor is suspended for exactly the two statements that borrow and
   * return the roles, and for nothing else. Not for the tests themselves: the
   * command's own refusals are what they assert, and a suite that ran with the
   * guard off throughout could not tell a bootstrap the command refused from
   * one the database refused.
   *
   * This is also the documented operator procedure for un-wedging a platform
   * that has genuinely lost its last administrator — see the runbook. It needs
   * table ownership, which the migration user has.
   */
  const withoutSuperAdminFloor = async (work: () => Promise<void>) => {
    await harness.prisma.$executeRawUnsafe(
      'ALTER TABLE "user" DISABLE TRIGGER enforce_super_admin_floor_trigger',
    );

    try {
      await work();
    } finally {
      await harness.prisma.$executeRawUnsafe(
        'ALTER TABLE "user" ENABLE TRIGGER enforce_super_admin_floor_trigger',
      );
    }
  };

  beforeAll(async () => {
    harness = await createHarness();

    const moduleRef = await Test.createTestingModule({ imports: [CliModule] })
      .overrideProvider(MAIL_TRANSPORT)
      .useValue(new CapturingTransport())
      .compile();

    // The testing module is itself an application context; `init` is what runs
    // the lifecycle hooks the CLI depends on, notably Prisma's connect.
    cli = await moduleRef.init();
    bootstrap = cli.get(SuperAdminBootstrap);
    policy = cli.get<PasswordPolicy>(PASSWORD_POLICY);

    await deleteFixtures();

    /**
     * The command refuses to run while *any* super administrator exists, and
     * the shared test database keeps the ones other suites create. So this
     * suite borrows the role: it strips `super_admin` from every account that
     * holds it and puts the original strings back in `afterAll`.
     *
     * That is safe only because the e2e project runs with `maxWorkers: 1`
     * (`test/jest-e2e.json`): no other suite is executing while this one holds
     * the roles, so nothing can observe or race the temporary state. If the e2e
     * run is ever parallelized, this suite needs its own database instead.
     */
    const holders = await harness.prisma.user.findMany({
      where: { role: { contains: SUPER_ADMIN } },
      select: { id: true, role: true },
    });

    borrowed = holders.filter((holder) =>
      rolesOf(holder.role).includes(SUPER_ADMIN),
    );

    await withoutSuperAdminFloor(async () => {
      for (const holder of borrowed) {
        const remaining = rolesOf(holder.role).filter(
          (role) => role !== SUPER_ADMIN,
        );

        await harness.prisma.user.update({
          where: { id: holder.id },
          data: { role: remaining.length > 0 ? remaining.join(',') : null },
        });
      }
    });
  }, 90_000);

  afterEach(async () => {
    await deleteFixtures();
  });

  afterAll(async () => {
    if (harness) {
      await deleteFixtures();

      await withoutSuperAdminFloor(async () => {
        for (const holder of borrowed) {
          await harness.prisma.user.update({
            where: { id: holder.id },
            data: { role: holder.role },
          });
        }
      });
    }

    await cli?.close();
    await harness?.close();
  }, 30_000);

  /**
   * Guards the fixture bookkeeping itself. Every assertion below means nothing
   * if the platform was not actually empty of super administrators first, and
   * a leaked row from a previous test would turn a real failure into a passing
   * `already-bootstrapped`.
   */
  beforeEach(async () => {
    await expect(superAdminIds()).resolves.toEqual([]);
  });

  describe('a successful bootstrap', () => {
    it('writes a verified super administrator with a hashed credential', async () => {
      const address = email('created');

      const outcome = await bootstrap.run({
        email: address,
        name: 'Bootstrap Owner',
        password: PASSWORD,
      });

      expect(outcome).toEqual({
        status: 'created',
        userId: expect.any(String),
        email: address,
      });

      const user = await harness.prisma.user.findFirst({
        where: { email: address },
        select: { id: true, name: true, role: true, emailVerified: true },
      });

      expect(user).toMatchObject({
        name: 'Bootstrap Owner',
        role: SUPER_ADMIN,
        // Sign-in requires it, and the verification mail has nowhere to go on a
        // platform this command is bootstrapping.
        emailVerified: true,
      });

      /**
       * The credential account is what `auth.api.createUser` is being used
       * for. A hand-written user row would satisfy every assertion above and
       * still leave an account with no way to authenticate.
       */
      const accounts = await harness.prisma.account.findMany({
        where: { userId: user?.id },
        select: { providerId: true, password: true },
      });

      expect(accounts).toHaveLength(1);
      expect(accounts[0].providerId).toBe('credential');
      expect(accounts[0].password).toEqual(expect.any(String));
      // Hashed, not stored. The column is `password`, and the failure mode
      // being excluded is that it holds the plaintext.
      expect(accounts[0].password).not.toContain(PASSWORD);
    }, 30_000);

    /**
     * The assertion the whole command exists for.
     *
     * Rows in the right shape prove nothing on their own: this is what proves
     * the password reached the configured hasher unmangled — no trailing
     * newline, no double-hash, no second hashing configuration — and that the
     * `emailVerified` flag really satisfies `requireEmailVerification` rather
     * than merely being set. Both are failures that only appear when the person
     * who owns the platform tries to sign in for the first time.
     */
    it('creates an account that can sign in with the password it was given', async () => {
      const address = email('signin');

      await bootstrap.run({
        email: address,
        name: 'Bootstrap Owner',
        password: PASSWORD,
      });

      const response = await trySignIn(harness, address, PASSWORD);

      expect(response.status).toBe(200);

      /**
       * The cookie is followed through to a session read, so what is proved is
       * an authenticated identity rather than a 200 and a `Set-Cookie` header.
       * The role travels with it: this is the account the Platform will treat
       * as the platform owner.
       */
      const session = await as(harness, {
        cookie: cookieOf(response),
      }).get('/api/auth/get-session');

      expect(session.status).toBe(200);
      expect(session.body).toMatchObject({
        user: { email: address, role: SUPER_ADMIN, emailVerified: true },
      });
    }, 30_000);

    it('refuses the password it was not given', async () => {
      const address = email('wrong-password');

      await bootstrap.run({
        email: address,
        name: 'Bootstrap Owner',
        password: PASSWORD,
      });

      const response = await trySignIn(harness, address, `${PASSWORD}-wrong`);

      expect(response.status).not.toBe(200);
    }, 30_000);
  });

  /**
   * The command's one guarantee: it works once. Everything after that is an
   * authorized grant performed by someone who already holds the role, so a
   * second invocation must not produce a second owner by any route.
   */
  it('refuses a second bootstrap and creates nothing', async () => {
    const first = await bootstrap.run({
      email: email('first'),
      name: 'First Owner',
      password: PASSWORD,
    });

    expect(first.status).toBe('created');

    const second = await bootstrap.run({
      email: email('second'),
      name: 'Second Owner',
      password: PASSWORD,
    });

    expect(second).toEqual({
      status: 'already-bootstrapped',
      existingCount: 1,
    });

    await expect(
      harness.prisma.user.findFirst({ where: { email: email('second') } }),
    ).resolves.toBeNull();
    await expect(superAdminIds()).resolves.toHaveLength(1);
  }, 40_000);

  /**
   * Reported separately from `already-bootstrapped` because the two call for
   * different next steps, and Better Auth's own duplicate rejection would say
   * neither. The account here is an ordinary one — the platform still has no
   * super administrator — so the only thing standing in the way is the address.
   */
  it('reports a taken email without touching the existing account', async () => {
    const address = email('taken');

    const existing = await harness.prisma.user.create({
      data: { email: address, name: 'Existing Person', role: 'user' },
      select: { id: true },
    });

    const outcome = await bootstrap.run({
      email: address,
      name: 'Bootstrap Owner',
      password: PASSWORD,
    });

    expect(outcome).toEqual({ status: 'email-taken' });

    const after = await harness.prisma.user.findUnique({
      where: { id: existing.id },
      select: { name: true, role: true },
    });

    expect(after).toEqual({ name: 'Existing Person', role: 'user' });
    await expect(superAdminIds()).resolves.toEqual([]);
  }, 30_000);

  /**
   * The gate counts holders of the role, not accounts the platform currently
   * lets in.
   *
   * Deactivation is a soft delete and a ban is a moderation state: both are
   * reversible, and both leave the account and its credential intact. If either
   * excluded a row from the count, anyone who can reach this command could mint
   * a brand-new root account on a live platform by first deactivating or
   * banning the existing owner — and every observable signal would say the
   * platform had simply never been bootstrapped.
   *
   * Written against real rows rather than a `where` clause, because the point
   * is the consequence and not the query: what must be true is that the command
   * still refuses.
   */
  describe('an existing super administrator the platform will not admit', () => {
    const createOwner = async (label: string) => {
      const address = email(label);

      const outcome = await bootstrap.run({
        email: address,
        name: 'Existing Owner',
        password: PASSWORD,
      });

      expect(outcome.status).toBe('created');

      return address;
    };

    it('still blocks a second bootstrap when it has been deactivated', async () => {
      const address = await createOwner('deactivated');

      /**
       * The floor is suspended to construct this state, and that is the point
       * rather than a workaround.
       *
       * Two invariants count differently, deliberately. This command's gate
       * counts *holders of the role*, so deactivating the owner cannot be used
       * to mint a second root account. The super-administrator floor counts
       * *usable* administrators, so a banned colleague is not mistaken for a
       * survivor. Where they disagree is exactly here — one holder, not usable
       * — and the floor now makes that state unreachable through any
       * application path, which is a better outcome than the one this test was
       * written to guard against.
       *
       * The gate still has to be right if the state arrives another way: a row
       * that predates the trigger, direct SQL, a restored backup. So the state
       * is built the only way it now can be, and the assertion is unchanged.
       */
      await withoutSuperAdminFloor(async () => {
        await harness.prisma.user.update({
          where: { email: address },
          data: { deletedAt: new Date(), deletionReason: 'e2e soft delete' },
        });
      });

      await expect(
        bootstrap.run({
          email: email('after-deactivation'),
          name: 'Replacement',
          password: PASSWORD,
        }),
      ).resolves.toEqual({ status: 'already-bootstrapped', existingCount: 1 });

      await expect(
        harness.prisma.user.findFirst({
          where: { email: email('after-deactivation') },
        }),
      ).resolves.toBeNull();
    }, 40_000);

    it('still blocks a second bootstrap when it has been banned', async () => {
      const address = await createOwner('banned');

      // Suspended for the same reason as the deactivation case above.
      await withoutSuperAdminFloor(async () => {
        await harness.prisma.user.update({
          where: { email: address },
          data: { banned: true, banReason: 'e2e ban' },
        });
      });

      await expect(
        bootstrap.run({
          email: email('after-ban'),
          name: 'Replacement',
          password: PASSWORD,
        }),
      ).resolves.toEqual({ status: 'already-bootstrapped', existingCount: 1 });
    }, 40_000);
  });

  /**
   * The length rule Better Auth's admin endpoint does not apply, read from the
   * deployment's own configuration.
   *
   * This is the half the unit tests cannot prove: they supply the bounds, so
   * they can show the rule is applied but not that the numbers are real. Here
   * the policy came out of the live Better Auth context, and the assertion is
   * that it matches what the sign-up path enforces rather than something this
   * command invented.
   */
  describe('the password policy', () => {
    it('reports the bounds the deployment actually configured', () => {
      expect(policy).toEqual({
        minLength: expect.any(Number),
        maxLength: expect.any(Number),
      });
      expect(policy.minLength).toBeGreaterThan(1);
      expect(policy.maxLength).toBeGreaterThan(policy.minLength);
    });

    /**
     * The finding this replaces: a one-character password produced a fully
     * usable super administrator, because the admin plugin's `createUser`
     * hashes whatever it is handed.
     */
    it('refuses a one-character password and writes nothing', async () => {
      const address = email('too-short');

      await expect(
        bootstrap.run({ email: address, name: 'Owner', password: 'x' }),
      ).resolves.toEqual({
        status: 'password-rejected',
        minLength: policy.minLength,
        maxLength: policy.maxLength,
      });

      await expect(
        harness.prisma.user.findFirst({ where: { email: address } }),
      ).resolves.toBeNull();
      await expect(superAdminIds()).resolves.toEqual([]);
    }, 30_000);

    it('refuses a password longer than the configured maximum', async () => {
      const address = email('too-long');

      await expect(
        bootstrap.run({
          email: address,
          name: 'Owner',
          password: 'p'.repeat(policy.maxLength + 1),
        }),
      ).resolves.toMatchObject({ status: 'password-rejected' });

      await expect(
        harness.prisma.user.findFirst({ where: { email: address } }),
      ).resolves.toBeNull();
    }, 30_000);

    /** The boundary is legal, and the account it produces really works. */
    it('accepts a password of exactly the minimum length', async () => {
      const address = email('exact-minimum');
      const exact = 'Pw1!'.repeat(policy.maxLength).slice(0, policy.minLength);

      await expect(
        bootstrap.run({ email: address, name: 'Owner', password: exact }),
      ).resolves.toMatchObject({ status: 'created' });

      const response = await trySignIn(harness, address, exact);

      expect(response.status).toBe(200);
    }, 40_000);
  });

  /**
   * The half-created account, reproduced against a real database.
   *
   * `createUser` is two writes with no transaction, and a failure between them
   * leaves a row holding `super_admin` with no credential — after which the
   * count says one, the command refuses forever, and the platform cannot be
   * bootstrapped without hand-editing SQL. Only the failing library call is
   * substituted; the cleanup, the relation query and the rows are real.
   */
  describe('a creation that fails between its two writes', () => {
    const failure = new Error('connection terminated unexpectedly');

    /** Writes the user row Better Auth would have written, then fails. */
    const failsAfterUserRow = (address: string): AdminUserApi => ({
      createUser: async () => {
        await harness.prisma.user.create({
          data: {
            email: address,
            name: 'Half Created',
            role: SUPER_ADMIN,
            emailVerified: true,
          },
        });

        throw failure;
      },
    });

    it('deletes the credential-less row it left behind', async () => {
      const address = email('orphan');

      await expect(
        bootstrapWith(failsAfterUserRow(address)).run({
          email: address,
          name: 'Half Created',
          password: PASSWORD,
        }),
      ).rejects.toThrow(failure);

      await expect(
        harness.prisma.user.findFirst({ where: { email: address } }),
      ).resolves.toBeNull();

      /**
       * And the gate is open again. Without the cleanup this is the assertion
       * that would fail: the orphan would count, and every later attempt —
       * including the operator's immediate retry — would report
       * `already-bootstrapped` on a platform with no usable administrator.
       */
      await expect(superAdminIds()).resolves.toEqual([]);
      await expect(
        bootstrap.run({
          email: email('after-orphan'),
          name: 'Retry Owner',
          password: PASSWORD,
        }),
      ).resolves.toMatchObject({ status: 'created' });
    }, 40_000);

    /**
     * The row has to be *ours*. The advisory lock excludes other bootstraps; it
     * does not exclude the public sign-up route, so between the email pre-check
     * and the failure a stranger can register that address — and sign-up also
     * writes the user row before the credential, so "no accounts yet" describes
     * their half-finished registration exactly as well as it describes our
     * orphan. The role is the only thing that tells them apart, and deleting on
     * the weaker test would destroy a real person's brand-new account.
     */
    it('leaves a credential-less row that a stranger registered', async () => {
      const address = email('stranger');

      const adminUsers: AdminUserApi = {
        createUser: async () => {
          await harness.prisma.user.create({
            data: { email: address, name: 'Stranger', role: 'user' },
          });

          throw failure;
        },
      };

      await expect(
        bootstrapWith(adminUsers).run({
          email: address,
          name: 'Owner',
          password: PASSWORD,
        }),
      ).rejects.toThrow(failure);

      await expect(
        harness.prisma.user.findFirst({
          where: { email: address },
          select: { name: true, role: true },
        }),
      ).resolves.toEqual({ name: 'Stranger', role: 'user' });
    }, 40_000);

    /**
     * A row that does have a credential is a usable account, so the failure
     * happened after both writes and deleting it would destroy data rather than
     * clean up after a failure.
     */
    it('leaves a row that already has a credential', async () => {
      const address = email('complete-then-fail');

      const adminUsers: AdminUserApi = {
        createUser: async () => {
          const user = await harness.prisma.user.create({
            data: {
              email: address,
              name: 'Complete',
              role: SUPER_ADMIN,
              emailVerified: true,
            },
          });

          await harness.prisma.account.create({
            data: {
              accountId: user.id,
              providerId: 'credential',
              userId: user.id,
              password: 'hashed-by-nobody',
            },
          });

          throw failure;
        },
      };

      await expect(
        bootstrapWith(adminUsers).run({
          email: address,
          name: 'Complete',
          password: PASSWORD,
        }),
      ).rejects.toThrow(failure);

      await expect(
        harness.prisma.user.findFirst({ where: { email: address } }),
      ).resolves.not.toBeNull();
    }, 40_000);
  });

  /**
   * The whole command, driven the way an operator drives it: a command name,
   * flags, and the password on stdin. Everything else in this suite calls
   * `run` directly, which skips the two places an argument can still be wrong —
   * the parser and the exit-code mapping.
   */
  describe('through the command line', () => {
    const commandIo = (password: string) => {
      const chunks: { out: string[]; err: string[] } = { out: [], err: [] };

      const sink = (into: string[]) =>
        new Writable({
          write(chunk: Buffer, _encoding, callback) {
            into.push(chunk.toString('utf8'));
            callback();
          },
        });

      const io: CommandIo = {
        input: Readable.from([Buffer.from(password, 'utf8')]),
        output: sink(chunks.out),
        error: sink(chunks.err),
      };

      return {
        io,
        get stdout() {
          return chunks.out.join('');
        },
        get stderr() {
          return chunks.err.join('');
        },
      };
    };

    const runCommand = (argv: string[], password: string) => {
      const streams = commandIo(password);

      return dispatchCliCommand(argv, streams.io, {
        bootstrap: () => Promise.resolve(bootstrap),
        // This suite exercises the bootstrap command only. A thunk that rejects
        // is the assertion that none of these paths reaches for rotation.
        rotation: () =>
          Promise.reject(new Error('rotation is not part of this suite')),
      }).then((code) => ({ code, ...streams }));
    };

    it('creates an administrator end to end and reports it on stdout', async () => {
      const address = email('cli-created');

      const result = await runCommand(
        ['super-admin:create', `--email=${address}`, '--name=CLI Owner'],
        PASSWORD,
      );

      expect(result.code).toBe(EXIT.ok);
      expect(result.stdout).toContain(`Created super administrator ${address}`);
      expect(result.stderr).toBe('');

      const response = await trySignIn(harness, address, PASSWORD);

      expect(response.status).toBe(200);
    }, 40_000);

    /**
     * Addresses are matched case-insensitively by Better Auth, so the pre-check
     * has to be too. Without the lowercasing this reaches the library instead
     * and comes back as the generic failure — exit 5 — so a script branching on
     * the code is told the bootstrap broke rather than that the address is
     * taken.
     */
    it('reports a differently-cased duplicate as email-taken', async () => {
      const address = email('cli-case');

      await harness.prisma.user.create({
        data: { email: address, name: 'Existing Person', role: 'user' },
      });

      const result = await runCommand(
        [
          'super-admin:create',
          `--email=${address.toUpperCase()}`,
          '--name=CLI Owner',
        ],
        PASSWORD,
      );

      expect(result.code).toBe(EXIT.emailTaken);
      expect(result.stderr).toContain('already exists');
      await expect(superAdminIds()).resolves.toEqual([]);
    }, 40_000);

    /** The live policy, reported to the operator as a usage error. */
    it('refuses a one-character password with the configured bounds', async () => {
      const result = await runCommand(
        [
          'super-admin:create',
          `--email=${email('cli-short')}`,
          '--name=CLI Owner',
        ],
        'x',
      );

      expect(result.code).toBe(EXIT.usage);
      expect(result.stderr).toBe(
        `The password must be between ${policy.minLength} and ${policy.maxLength} characters.\n`,
      );
      expect(result.stdout).toBe('');
    }, 30_000);
  });

  /**
   * The advisory lock's entire reason to exist.
   *
   * The command is check-then-write over an *absence*, which no row lock and no
   * unique constraint can serialize: there is nothing to lock and nothing to
   * collide. Two operators running it at the same moment — or one operator
   * running it twice impatiently — would both read an empty platform and both
   * create an owner, and nothing afterwards would say which one is the real
   * administrator.
   *
   * The pair is asserted to be exactly one `created` and one `locked`. An
   * `already-bootstrapped` in the second slot would mean the two calls did not
   * actually overlap, and a test that accepted it would be proving nothing;
   * two `created` would mean the lock is not doing its job.
   */
  it('lets exactly one of two concurrent bootstraps through', async () => {
    const outcomes = await Promise.all([
      bootstrap.run({
        email: email('race-a'),
        name: 'Racer A',
        password: PASSWORD,
      }),
      bootstrap.run({
        email: email('race-b'),
        name: 'Racer B',
        password: PASSWORD,
      }),
    ]);

    const statuses = outcomes
      .map((outcome: BootstrapOutcome) => outcome.status)
      .sort();

    expect(statuses).toEqual(['created', 'locked']);

    await expect(superAdminIds()).resolves.toHaveLength(1);

    const created = await harness.prisma.user.findMany({
      where: { email: { startsWith: PREFIX } },
      select: { email: true },
    });

    expect(created).toHaveLength(1);
  }, 40_000);

  /**
   * The lock is a session on its own connection, so a run that does not release
   * it would leave every later attempt reporting `locked` — including the
   * operator's own retry after a failure. Sequential runs are the observable
   * form of that.
   */
  it('releases the lock so a later run is not blocked by an earlier one', async () => {
    const first = await bootstrap.run({
      email: email('release-a'),
      name: 'Releaser A',
      password: PASSWORD,
    });

    expect(first.status).toBe('created');

    await harness.prisma.user.deleteMany({
      where: { email: email('release-a') },
    });

    const second = await bootstrap.run({
      email: email('release-b'),
      name: 'Releaser B',
      password: PASSWORD,
    });

    // Not `locked`: the first run gave its connection back.
    expect(second.status).toBe('created');
  }, 40_000);
});
