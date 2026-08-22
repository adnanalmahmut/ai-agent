import { AuthService } from '@thallesp/nestjs-better-auth';

import type { AppAuth } from '../core/auth';

/** Injection token for the narrowed admin surface the CLI needs. */
export const ADMIN_USER_API = Symbol('ADMIN_USER_API');

/** Injection token for the deployment's configured password length bounds. */
export const PASSWORD_POLICY = Symbol('PASSWORD_POLICY');

/**
 * The one Better Auth endpoint this process calls, as a port.
 *
 * `AppAuth` is deliberately the library's base `Auth` type
 * (`auth.factory.ts`), and the factory's `plugins` array is assembled
 * conditionally, so TypeScript cannot infer the admin plugin's endpoints onto
 * `auth.api` — `createUser` exists at runtime and is invisible to the compiler.
 * Widening the factory's return type does not fix it: the conditional array is
 * not a tuple, so the inference is lost before it reaches the return.
 *
 * Rather than scatter an `as` through the bootstrap logic, the narrowing
 * happens exactly once, in `resolveAdminUserApi`, behind a runtime check. What
 * that buys is the difference between the two failure modes: an unguarded cast
 * turns a removed or renamed endpoint into `undefined is not a function` deep
 * inside a command holding a plaintext password, while the guard turns it into
 * a stated error at startup. The e2e test then proves the shape is real against
 * the actual library rather than against this declaration.
 */
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

/** The configured password length bounds, in the units the operator sees. */
export type PasswordPolicy = { minLength: number; maxLength: number };

/**
 * Reads the configured password policy so the CLI can apply it.
 *
 * The command originally delegated length rules to Better Auth on the stated
 * grounds that a second opinion would diverge from the sign-in path. That
 * reasoning was right and the delegation was wrong: verified against
 * `better-auth@1.6.27`, the admin plugin's `createUser` route goes straight from
 * `internalAdapter.createUser` to `password.hash` and never consults
 * `minPasswordLength` or `maxPasswordLength` — those are read only by
 * `sign-up`, `reset-password`, `update-user` and friends. So the endpoint that
 * creates the platform's most privileged account, the one nobody can reset, was
 * the one endpoint enforcing nothing, and a one-character password produced a
 * fully usable super administrator.
 *
 * Reading the numbers out of the live configuration rather than restating them
 * keeps the original intent — one opinion, not two — while actually delivering
 * it. If the deployment raises `minPasswordLength`, this moves with it.
 */
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
    /**
     * Refusing rather than falling back to a guessed default. A wrong default
     * here is silently weaker than the platform's real policy, and the whole
     * point of this function is not to hold a second opinion.
     */
    throw new Error(
      'Better Auth did not report a password length policy; refusing to create an account without one.',
    );
  }

  return {
    minLength: config.minPasswordLength,
    maxLength: config.maxPasswordLength,
  };
}
