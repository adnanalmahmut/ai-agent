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

import { databaseConfig } from '../../../src/infrastructure/config';
import type {
  AdminUserApi,
  PasswordPolicy,
} from '../../../src/cli/admin-user-api';
import { PASSWORD_POLICY } from '../../../src/cli/admin-user-api';
import { CliModule } from '../../../src/cli/cli.module';
import { dispatchCliCommand } from '../../../src/cli/dispatch';
import type { BootstrapOutcome } from '../../../src/cli/super-admin.bootstrap';
import { SuperAdminBootstrap } from '../../../src/cli/super-admin.bootstrap';
import { EXIT, type CommandIo } from '../../../src/cli/super-admin.command';
import { MAIL_TRANSPORT } from '../../../src/infrastructure/mail/mail-transport';
import {
  as,
  CapturingTransport,
  cookieOf,
  createHarness,
  trySignIn,
  type Harness,
} from '../../support/auth-harness';

const PREFIX = `super-admin-cli-e2e-${process.pid}`;
const email = (label: string) => `${PREFIX}-${label}@example.test`;

const PASSWORD = 'Bootstrap-e2e-P4ssword';

const SUPER_ADMIN = 'super_admin';

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

  const bootstrapWith = (adminUsers: AdminUserApi) =>
    new SuperAdminBootstrap(
      harness.prisma,
      adminUsers,
      policy,
      cli.get(databaseConfig.KEY),
    );

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
    await harness.prisma.user.deleteMany({
      where: { email: { startsWith: PREFIX } },
    });
  };

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

    cli = await moduleRef.init();
    bootstrap = cli.get(SuperAdminBootstrap);
    policy = cli.get<PasswordPolicy>(PASSWORD_POLICY);

    await deleteFixtures();

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
        emailVerified: true,
      });

      const accounts = await harness.prisma.account.findMany({
        where: { userId: user?.id },
        select: { providerId: true, password: true },
      });

      expect(accounts).toHaveLength(1);
      expect(accounts[0].providerId).toBe('credential');
      expect(accounts[0].password).toEqual(expect.any(String));
      expect(accounts[0].password).not.toContain(PASSWORD);
    }, 30_000);

    it('creates an account that can sign in with the password it was given', async () => {
      const address = email('signin');

      await bootstrap.run({
        email: address,
        name: 'Bootstrap Owner',
        password: PASSWORD,
      });

      const response = await trySignIn(harness, address, PASSWORD);

      expect(response.status).toBe(200);

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

  describe('the password policy', () => {
    it('reports the bounds the deployment actually configured', () => {
      expect(policy).toEqual({
        minLength: expect.any(Number),
        maxLength: expect.any(Number),
      });
      expect(policy.minLength).toBeGreaterThan(1);
      expect(policy.maxLength).toBeGreaterThan(policy.minLength);
    });

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

  describe('a creation that fails between its two writes', () => {
    const failure = new Error('connection terminated unexpectedly');

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

      await expect(superAdminIds()).resolves.toEqual([]);
      await expect(
        bootstrap.run({
          email: email('after-orphan'),
          name: 'Retry Owner',
          password: PASSWORD,
        }),
      ).resolves.toMatchObject({ status: 'created' });
    }, 40_000);

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

    expect(second.status).toBe('created');
  }, 40_000);
});
