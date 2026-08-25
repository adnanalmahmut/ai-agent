import { describe, expect, it, jest } from '@jest/globals';
import type { AuthService } from '@thallesp/nestjs-better-auth';

import type { AppAuth } from '../../core/auth';
import { resolveAdminUserApi, resolvePasswordPolicy } from '../admin-user-api';

/**
 * The two things this process reads out of an untyped Better Auth instance,
 * and what happens when they are not there.
 *
 * Both are narrowings the compiler cannot check: the admin plugin's endpoints
 * are invisible on `auth.api`, and the password policy lives on a runtime
 * context object. So the guards are the only thing standing between a library
 * upgrade and a command that fails somewhere deep inside itself while holding a
 * plaintext password — or, worse, one that quietly stops enforcing a rule and
 * says nothing. The e2e suite proves the happy paths against the real library;
 * these prove the refusals, which the real library will not produce on demand.
 */

const authOf = (instance: unknown, api: unknown = {}): AuthService<AppAuth> =>
  ({ api, instance }) as unknown as AuthService<AppAuth>;

const contextOf = (context: unknown) => ({
  $context: Promise.resolve(context),
});

describe('resolveAdminUserApi', () => {
  it('returns the api when the admin endpoint is present', () => {
    const createUser = jest.fn();

    expect(resolveAdminUserApi(authOf({}, { createUser }))).toMatchObject({
      createUser,
    });
  });

  /**
   * A stated error at startup rather than `undefined is not a function` in the
   * middle of a command that has already read the operator's password. The
   * failure this converts is a plugin removed from the conditional array, or an
   * endpoint renamed by an upgrade — both silent to the compiler.
   */
  it.each([
    ['the endpoint is missing', {}],
    ['the endpoint is not callable', { createUser: 'nope' }],
  ])('refuses when %s', (_label, api) => {
    expect(() => resolveAdminUserApi(authOf({}, api))).toThrow(
      /does not expose createUser/,
    );
  });
});

describe('resolvePasswordPolicy', () => {
  it('reads the configured bounds from the live context', async () => {
    const auth = authOf(
      contextOf({
        password: { config: { minPasswordLength: 8, maxPasswordLength: 128 } },
      }),
    );

    await expect(resolvePasswordPolicy(auth)).resolves.toEqual({
      minLength: 8,
      maxLength: 128,
    });
  });

  /** Whatever the deployment configured, not a remembered default. */
  it('carries non-default bounds through unchanged', async () => {
    const auth = authOf(
      contextOf({
        password: { config: { minPasswordLength: 16, maxPasswordLength: 64 } },
      }),
    );

    await expect(resolvePasswordPolicy(auth)).resolves.toEqual({
      minLength: 16,
      maxLength: 64,
    });
  });

  /**
   * Refusing beats defaulting, and this is the assertion that keeps it that
   * way. A fallback of, say, 8 would look reasonable and would be wrong in the
   * only direction that matters: if the deployment had configured something
   * stricter, the one account nobody can reset would be the one account created
   * under a weaker rule than the platform's own — and nothing would report it.
   * The whole point of reading the number is to avoid holding a second opinion,
   * and a guessed default is a second opinion.
   */
  it.each([
    ['the context has no password section', {}],
    ['the password section has no config', { password: {} }],
    [
      'the minimum is absent',
      { password: { config: { maxPasswordLength: 128 } } },
    ],
    [
      'the maximum is absent',
      { password: { config: { minPasswordLength: 8 } } },
    ],
    [
      'a bound is not a number',
      {
        password: {
          config: { minPasswordLength: '8', maxPasswordLength: 128 },
        },
      },
    ],
  ])('refuses when %s', async (_label, context) => {
    await expect(
      resolvePasswordPolicy(authOf(contextOf(context))),
    ).rejects.toThrow(/did not report a password length policy/);
  });
});
