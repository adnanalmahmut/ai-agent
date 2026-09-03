import { AuthService } from '@thallesp/nestjs-better-auth';

import type { AppAuth } from '../infrastructure/auth';

export const ADMIN_USER_API = Symbol('ADMIN_USER_API');

export const PASSWORD_POLICY = Symbol('PASSWORD_POLICY');

export type AdminUserApi = {
  createUser(request: {
    body: {
      email: string;
      password: string;
      name: string;
      role: string;
      data?: Record<string, unknown>;
    };
  }): Promise<{ user: { id: string; email: string } }>;
};

export function resolveAdminUserApi(auth: AuthService<AppAuth>): AdminUserApi {
  const api = auth.api as unknown as Partial<AdminUserApi>;

  if (typeof api.createUser !== 'function') {
    throw new Error(
      'The Better Auth admin plugin does not expose createUser; the bootstrap command cannot create an account safely.',
    );
  }

  return api as AdminUserApi;
}

export type PasswordPolicy = { minLength: number; maxLength: number };

export async function resolvePasswordPolicy(
  auth: AuthService<AppAuth>,
): Promise<PasswordPolicy> {
  const context = (await auth.instance.$context) as {
    password?: {
      config?: { minPasswordLength?: number; maxPasswordLength?: number };
    };
  };

  const config = context.password?.config;

  if (
    typeof config?.minPasswordLength !== 'number' ||
    typeof config.maxPasswordLength !== 'number'
  ) {
    throw new Error(
      'Better Auth did not report a password length policy; refusing to create an account without one.',
    );
  }

  return {
    minLength: config.minPasswordLength,
    maxLength: config.maxPasswordLength,
  };
}
