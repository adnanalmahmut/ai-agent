// The server entry, imported *only* here: this suite exists to check the
// mapping against the codes the installed package really ships, and reading
// them from the source of truth is the whole point. No application module
// imports it — an architecture test enforces that.
//
// Each entry is `{ code, message }`, so `.code` is the machine-readable half
// — the same value that reaches the browser on an error body, and the only
// half this application is allowed to branch on.
import { BASE_ERROR_CODES } from 'better-auth';
import { ADMIN_ERROR_CODES } from 'better-auth/client/plugins';
import { describe, expect, it } from 'vitest';

import {
  AUTH_ERROR_CODES,
  type AuthErrorCode,
  BACKEND_ERROR_CODES,
  authErrorFromCallback,
  authErrorMessageKey,
  normalizeAuthError,
} from './auth-errors';

/**
 * Error normalisation.
 *
 * The codes on the left of every case below are read from the *installed*
 * Better Auth rather than typed from memory — so a rename in a future version
 * fails here instead of silently degrading every message to "something went
 * wrong".
 */
describe('normalizeAuthError', () => {
  it('collapses every credential failure into one state', () => {
    // Distinguishing them would make the sign-in form an oracle for whether
    // an address is registered.
    for (const code of [
      BASE_ERROR_CODES.INVALID_EMAIL_OR_PASSWORD.code,
      BASE_ERROR_CODES.INVALID_PASSWORD.code,
      BASE_ERROR_CODES.INVALID_EMAIL.code,
      BASE_ERROR_CODES.USER_NOT_FOUND.code,
      BASE_ERROR_CODES.CREDENTIAL_ACCOUNT_NOT_FOUND.code,
    ]) {
      expect(normalizeAuthError({ code, status: 401 })).toBe(
        'INVALID_CREDENTIALS',
      );
    }
  });

  it.each<[string, AuthErrorCode]>([
    [BASE_ERROR_CODES.EMAIL_NOT_VERIFIED.code, 'EMAIL_NOT_VERIFIED'],
    [BASE_ERROR_CODES.EMAIL_ALREADY_VERIFIED.code, 'EMAIL_ALREADY_VERIFIED'],
    [BASE_ERROR_CODES.USER_ALREADY_EXISTS.code, 'EMAIL_ALREADY_REGISTERED'],
    [BASE_ERROR_CODES.PASSWORD_TOO_SHORT.code, 'WEAK_PASSWORD'],
    [BASE_ERROR_CODES.PASSWORD_TOO_LONG.code, 'WEAK_PASSWORD'],
    [BASE_ERROR_CODES.INVALID_TOKEN.code, 'INVALID_TOKEN'],
    [BASE_ERROR_CODES.TOKEN_EXPIRED.code, 'TOKEN_EXPIRED'],
    [BASE_ERROR_CODES.PROVIDER_NOT_FOUND.code, 'PROVIDER_UNAVAILABLE'],
    [BASE_ERROR_CODES.SOCIAL_ACCOUNT_ALREADY_LINKED.code, 'ACCOUNT_LINK_CONFLICT'],
    [BASE_ERROR_CODES.SESSION_EXPIRED.code, 'UNAUTHENTICATED'],
    [ADMIN_ERROR_CODES.BANNED_USER.code, 'ACCOUNT_BANNED'],
  ])('maps %s', (code, expected) => {
    expect(normalizeAuthError({ code })).toBe(expected);
  });

  it('recognises this project own backend codes', () => {
    // Emitted by `databaseHooks.session.create.before` in the backend, so a
    // deactivated account gets its own message rather than "invalid password".
    expect(
      normalizeAuthError({
        code: BACKEND_ERROR_CODES.accountDeactivated,
        status: 403,
      }),
    ).toBe('ACCOUNT_DEACTIVATED');
  });

  it('reads the nested error of a { data, error } response', () => {
    expect(
      normalizeAuthError({
        data: null,
        error: { code: BASE_ERROR_CODES.EMAIL_NOT_VERIFIED.code, status: 403 },
      }),
    ).toBe('EMAIL_NOT_VERIFIED');
  });

  describe('falls back to the status when there is no code', () => {
    it.each<[number, AuthErrorCode]>([
      [429, 'RATE_LIMITED'],
      [401, 'UNAUTHENTICATED'],
      [403, 'FORBIDDEN'],
      [500, 'UNKNOWN'],
    ])('%s', (status, expected) => {
      expect(normalizeAuthError({ status })).toBe(expected);
    });
  });

  it('reports a request that never reached the server', () => {
    // A fetch rejection: no status, no code. "Check your connection" is a
    // different remedy from anything the server could have said.
    expect(normalizeAuthError(new TypeError('Failed to fetch'))).toBe(
      'NETWORK_ERROR',
    );
    expect(normalizeAuthError({})).toBe('NETWORK_ERROR');
    expect(normalizeAuthError('boom')).toBe('NETWORK_ERROR');
  });

  it('never throws, whatever it is handed', () => {
    for (const input of [null, undefined, 0, [], { error: null }]) {
      expect(AUTH_ERROR_CODES).toContain(normalizeAuthError(input));
    }
  });

  it('maps an unrecognised code to a generic state rather than showing it', () => {
    expect(normalizeAuthError({ code: 'SOME_FUTURE_CODE', status: 418 })).toBe(
      'UNKNOWN',
    );
  });
});

describe('authErrorFromCallback', () => {
  it('reports no failure when there is no error parameter', () => {
    expect(authErrorFromCallback(null)).toBeNull();
    expect(authErrorFromCallback(undefined)).toBeNull();
    expect(authErrorFromCallback('')).toBeNull();
  });

  it('reads the code Better Auth appends to a callback URL', () => {
    expect(authErrorFromCallback('TOKEN_EXPIRED')).toBe('TOKEN_EXPIRED');
    expect(authErrorFromCallback('INVALID_TOKEN')).toBe('INVALID_TOKEN');
  });
});

describe('authErrorMessageKey', () => {
  it('produces a distinct key per state', () => {
    const keys = AUTH_ERROR_CODES.map(authErrorMessageKey);

    expect(new Set(keys).size).toBe(AUTH_ERROR_CODES.length);
  });
});
