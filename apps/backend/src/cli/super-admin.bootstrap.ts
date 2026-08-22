import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { databaseConfig } from '../config';
import { SUPER_ADMIN_ROLE } from '../core/auth';
import { PrismaService } from '../database';
import {
  ADMIN_USER_API,
  PASSWORD_POLICY,
  type AdminUserApi,
  type PasswordPolicy,
} from './admin-user-api';
import { acquireBootstrapLock } from './bootstrap-lock';

/**
 * Every way the command can end, as data rather than as a thrown error.
 *
 * The caller turns these into exit codes and messages, which keeps the decision
 * about what an operator sees in one place and lets a test assert the outcome
 * without parsing output.
 */
export type BootstrapOutcome =
  | { status: 'created'; userId: string; email: string }
  | { status: 'already-bootstrapped'; existingCount: number }
  | { status: 'locked' }
  | { status: 'email-taken' }
  | { status: 'password-rejected'; minLength: number; maxLength: number };

export type BootstrapRequest = {
  email: string;
  name: string;
  password: string;
};

/**
 * Reads the comma-separated role column the way Better Auth writes it.
 *
 * A `contains` match alone would be wrong the moment a role name is a substring
 * of another, and role catalogues grow. Splitting is cheap and cannot be
 * surprised.
 */
function hasSuperAdminRole(role: string | null): boolean {
  if (!role) return false;

  return role
    .split(',')
    .map((entry) => entry.trim())
    .includes(SUPER_ADMIN_ROLE);
}

/**
 * Creates the platform's first super administrator.
 *
 * This is the one privilege escalation the application performs without an
 * authenticated actor, so it is constrained by when it may run rather than by
 * who runs it: it works exactly once, on a platform that has no super
 * administrator yet. After that the answer is permanently "no", and granting
 * the role becomes an authorized operation performed by someone who already
 * holds it.
 *
 * ## Why it goes through Better Auth
 *
 * `auth.api.createUser` is the admin plugin's own endpoint, invoked in-process
 * with no request and no headers. Better Auth treats a call with neither as
 * server-side and skips the session requirement — the documented convention for
 * its request-optional endpoints — which is what makes it reachable before any
 * session can possibly exist.
 *
 * Going through it rather than writing the rows directly is deliberate. It
 * hashes with the configured password implementation, links the credential
 * account under the `credential` provider, and validates the role against the
 * same catalogue the API enforces. Writing two of those three by hand would
 * produce an account that looks right until someone tries to sign in with it.
 *
 * `emailVerified` is set at creation because the alternative is an account
 * nobody can use: verification is mandatory for sign-in, the verification mail
 * goes wherever the mail driver points — which on a fresh deployment is the log
 * — and the operator creating this account is the person who owns the platform.
 * The trade is recorded in the runbook rather than left implicit.
 */
@Injectable()
export class SuperAdminBootstrap {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ADMIN_USER_API)
    private readonly adminUsers: AdminUserApi,
    @Inject(PASSWORD_POLICY)
    private readonly passwordPolicy: PasswordPolicy,
    @Inject(databaseConfig.KEY)
    private readonly database: ConfigType<typeof databaseConfig>,
  ) {}

  /**
   * Counts existing super administrators.
   *
   * Public so the command can report the state without attempting a write, and
   * so the check is testable independently of the lock.
   */
  async countSuperAdmins(): Promise<number> {
    const candidates = await this.prisma.user.findMany({
      where: { role: { contains: SUPER_ADMIN_ROLE } },
      select: { role: true },
    });

    return candidates.filter((candidate) => hasSuperAdminRole(candidate.role))
      .length;
  }

  async run(request: BootstrapRequest): Promise<BootstrapOutcome> {
    const { minLength, maxLength } = this.passwordPolicy;

    /**
     * Enforced here because Better Auth's `createUser` does not enforce it.
     * Verified against 1.6.27: the admin route hashes whatever it is given, so
     * without this the one account nobody can reset is the one account with no
     * password policy. The bounds are read from the live configuration rather
     * than restated, so this stays a single opinion; see `resolvePasswordPolicy`.
     *
     * Checked before the lock is taken: it is a property of the request alone,
     * and a rejected password should not make a second operator wait.
     */
    if (
      request.password.length < minLength ||
      request.password.length > maxLength
    ) {
      return { status: 'password-rejected', minLength, maxLength };
    }

    /**
     * The lock spans the check and the write, because the command's shape is
     * check-then-write over an absence and that is a race by construction. It
     * is held on its own connection for the whole operation; see
     * `bootstrap-lock.ts` for why it cannot be taken through Prisma.
     */
    const lock = await acquireBootstrapLock(
      this.database.url,
      this.database.connectTimeoutMs,
    );

    if (!lock) return { status: 'locked' };

    try {
      const existingCount = await this.countSuperAdmins();

      if (existingCount > 0) {
        return { status: 'already-bootstrapped', existingCount };
      }

      /**
       * Checked separately from the role count so the operator is told which
       * condition failed. Better Auth would reject the duplicate anyway, but
       * "that email already belongs to an account" and "this platform already
       * has an administrator" call for different next steps.
       */
      const existingUser = await this.prisma.user.findUnique({
        where: { email: request.email },
        select: { id: true },
      });

      if (existingUser) return { status: 'email-taken' };

      try {
        const created = await this.adminUsers.createUser({
          body: {
            email: request.email,
            password: request.password,
            name: request.name,
            role: SUPER_ADMIN_ROLE,
            // Sign-in requires a verified address, and the verification mail
            // has nowhere useful to go on a platform being bootstrapped.
            data: { emailVerified: true },
          },
        });

        return {
          status: 'created',
          userId: created.user.id,
          email: created.user.email,
        };
      } catch (error) {
        await this.removeOrphanedUser(request.email);

        throw error;
      }
    } finally {
      await lock.release();
    }
  }

  /**
   * Deletes a half-created account so a failed bootstrap can be retried.
   *
   * `createUser` is two writes and no transaction: Better Auth inserts the user
   * row, then hashes the password and links the credential account. A failure
   * between them leaves a row with `role = super_admin` and nothing to sign in
   * with — after which `countSuperAdmins` returns one, the command refuses
   * permanently, and the platform is unrecoverable without direct SQL. That is
   * the worst outcome available to this feature, and it is reachable from an
   * ordinary connection blip.
   *
   * Two conditions make the deletion safe, and both are necessary. The row must
   * have no credential account, and it must carry the super administrator role.
   *
   * The role check is not redundant. The advisory lock excludes other bootstrap
   * processes, not the world: the public sign-up route is live, so a stranger
   * could register this address between the pre-check and the failure, and
   * "the email was absent moments ago" does not prove the row is ours. A
   * self-registered account has the default role, so requiring the role this
   * command grants narrows the deletion to rows only this command creates.
   *
   * Failure to clean up is swallowed deliberately — the original error is what
   * the operator needs to see, and the runbook covers the residue.
   */
  private async removeOrphanedUser(email: string): Promise<void> {
    try {
      const orphan = await this.prisma.user.findUnique({
        where: { email },
        select: {
          id: true,
          role: true,
          accounts: { select: { id: true }, take: 1 },
        },
      });

      if (!orphan || orphan.accounts.length > 0) return;
      if (!hasSuperAdminRole(orphan.role)) return;

      await this.prisma.user.delete({ where: { id: orphan.id } });
    } catch {
      return;
    }
  }
}
