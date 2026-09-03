import { describe, expect, it, jest } from '@jest/globals';
import type { AuthService } from '@thallesp/nestjs-better-auth';

import type { AppAuth } from '../../../src/infrastructure/auth';
import {
  resolveAdminUserApi,
  resolvePasswordPolicy,
} from '../../../src/cli/admin-user-api';

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
