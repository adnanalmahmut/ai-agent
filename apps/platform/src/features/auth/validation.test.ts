import { describe, expect, it } from 'vitest';

import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  requestPasswordResetSchema,
  resetPasswordSchema,
  signInSchema,
  signUpSchema,
  validate,
} from './validation';

describe('sign-in validation', () => {
  it('accepts a filled form', () => {
    const result = validate(signInSchema, {
      email: 'sara@example.com',
      password: 'anything',
    });

    expect(result).toEqual({
      ok: true,
      values: { email: 'sara@example.com', password: 'anything' },
    });
  });

  it('trims the email so a stray space is not a failed sign-in', () => {
    const result = validate(signInSchema, {
      email: '  sara@example.com ',
      password: 'anything',
    });

    expect(result.ok && result.values.email).toBe('sara@example.com');
  });

  it('reports translation keys, never sentences', () => {
    const result = validate(signInSchema, { email: 'nope', password: '' });

    expect(result).toEqual({
      ok: false,
      issues: { email: 'emailInvalid', password: 'passwordRequired' },
    });
  });

  it('does not impose a length rule on an existing password', () => {
    // An account created before a rule changed must still be able to sign in;
    // only the server may reject the value.
    expect(
      validate(signInSchema, {
        email: 'sara@example.com',
        password: 'short',
      }).ok,
    ).toBe(true);
  });
});

describe('sign-up validation', () => {
  it('accepts a complete form', () => {
    expect(
      validate(signUpSchema, {
        name: 'Sara Haddad',
        email: 'sara@example.com',
        password: 'a-good-password',
      }).ok,
    ).toBe(true);
  });

  it.each([
    ['name', 'nameRequired', { name: '', email: 'a@b.co', password: 'a-good-password' }],
    ['email', 'emailRequired', { name: 'Sara', email: '', password: 'a-good-password' }],
    ['email', 'emailInvalid', { name: 'Sara', email: 'nope', password: 'a-good-password' }],
    ['password', 'passwordRequired', { name: 'Sara', email: 'a@b.co', password: '' }],
    ['password', 'passwordTooShort', { name: 'Sara', email: 'a@b.co', password: 'short' }],
  ])('reports %s as %s', (field, key, input) => {
    const result = validate(signUpSchema, input);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues[field as 'name']).toBe(key);
  });

  it('mirrors the installed Better Auth password bounds', () => {
    // Read from `context/create-context.mjs` in 1.6.27, which the backend does
    // not override. Guessing tighter would reject what the server accepts.
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    expect(PASSWORD_MAX_LENGTH).toBe(128);

    const at = (length: number) =>
      validate(signUpSchema, {
        name: 'Sara',
        email: 'a@b.co',
        password: 'a'.repeat(length),
      }).ok;

    expect(at(PASSWORD_MIN_LENGTH)).toBe(true);
    expect(at(PASSWORD_MIN_LENGTH - 1)).toBe(false);
    expect(at(PASSWORD_MAX_LENGTH)).toBe(true);
    expect(at(PASSWORD_MAX_LENGTH + 1)).toBe(false);
  });

  it('keeps only the first complaint per field', () => {
    const result = validate(signUpSchema, {
      name: '',
      email: '',
      password: '',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(Object.keys(result.issues).sort()).toEqual([
      'email',
      'name',
      'password',
    ]);
  });
});

describe('password reset validation', () => {
  it('requires an email to request a reset', () => {
    expect(validate(requestPasswordResetSchema, { email: '' })).toEqual({
      ok: false,
      issues: { email: 'emailRequired' },
    });
  });

  it('requires both passwords to match', () => {
    expect(
      validate(resetPasswordSchema, {
        password: 'a-good-password',
        confirmPassword: 'a-different-one',
      }),
    ).toEqual({
      ok: false,
      issues: { confirmPassword: 'passwordsDoNotMatch' },
    });
  });

  it('accepts a matching pair', () => {
    expect(
      validate(resetPasswordSchema, {
        password: 'a-good-password',
        confirmPassword: 'a-good-password',
      }).ok,
    ).toBe(true);
  });

  it('reports the weak password before the mismatch', () => {
    // Both are wrong; "too short" is the actionable half.
    const result = validate(resetPasswordSchema, {
      password: 'short',
      confirmPassword: '',
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.password).toBe(
      'passwordTooShort',
    );
  });
});
