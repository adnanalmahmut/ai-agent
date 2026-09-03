import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { databaseConfig } from '../infrastructure/config';
import { SUPER_ADMIN_ROLE } from '../infrastructure/auth';
import { PrismaService } from '../infrastructure/database';
import {
  ADMIN_USER_API,
  PASSWORD_POLICY,
  type AdminUserApi,
  type PasswordPolicy,
} from './admin-user-api';
import { acquireBootstrapLock } from './bootstrap-lock';

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

function hasSuperAdminRole(role: string | null): boolean {
  if (!role) return false;

  return role
    .split(',')
    .map((entry) => entry.trim())
    .includes(SUPER_ADMIN_ROLE);
}

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

    if (
      request.password.length < minLength ||
      request.password.length > maxLength
    ) {
      return { status: 'password-rejected', minLength, maxLength };
    }

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
