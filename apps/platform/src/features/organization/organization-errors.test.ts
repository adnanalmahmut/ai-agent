import { ORGANIZATION_ERROR_CODES } from 'better-auth/client/plugins';
import { describe, expect, it } from 'vitest';

import { ApiError, ApiUnavailableError } from '@/lib/application-api';

import {
  ORGANIZATION_ERRORS,
  organizationErrorFrom,
  organizationErrorKey,
} from './organization-errors';

/**
 * Failure normalisation.
 *
 * The codes on the left of the mapping are read from the **installed** Better
 * Auth rather than typed out, so a rename upstream fails the build here
 * instead of quietly degrading every message in the organization feature to
 * "something went wrong".
 */
const codes = ORGANIZATION_ERROR_CODES;

describe('Better Auth failures', () => {
  it.each([
    [codes.ORGANIZATION_SLUG_ALREADY_TAKEN, 'SLUG_TAKEN'],
    [codes.ORGANIZATION_ALREADY_EXISTS, 'SLUG_TAKEN'],
    [codes.USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION, 'ALREADY_A_MEMBER'],
    [codes.USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION, 'ALREADY_INVITED'],
    [codes.ORGANIZATION_MEMBERSHIP_LIMIT_REACHED, 'MEMBER_LIMIT_REACHED'],
    [codes.INVITATION_LIMIT_REACHED, 'INVITATION_LIMIT_REACHED'],
    [codes.MEMBER_NOT_FOUND, 'MEMBER_NOT_FOUND'],
    [codes.INVITATION_NOT_FOUND, 'INVITATION_NOT_FOUND'],
    [codes.YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE, 'ROLE_NOT_ALLOWED'],
    [codes.YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER, 'LAST_OWNER'],
    [codes.USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION, 'NOT_A_MEMBER'],
    [codes.ORGANIZATION_NOT_FOUND, 'ORGANIZATION_NOT_FOUND'],
    [
      codes.YOU_HAVE_REACHED_THE_MAXIMUM_NUMBER_OF_ORGANIZATIONS,
      'ORGANIZATION_LIMIT_REACHED',
    ],
  ])('%s → %s', (code, expected) => {
    expect(organizationErrorFrom({ error: { code: code.code } })).toBe(expected);
  });

  it('collapses every flavour of "not allowed" into one state', () => {
    // The reader does not care which verb was refused, only that it was.
    const refusals = [
      codes.YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_ORGANIZATION,
      codes.YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER,
      codes.YOU_ARE_NOT_ALLOWED_TO_CANCEL_THIS_INVITATION,
      codes.YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION,
    ];

    for (const refusal of refusals) {
      expect(organizationErrorFrom({ error: { code: refusal.code } })).toBe(
        'FORBIDDEN',
      );
    }
  });
});

describe('this application’s own backend', () => {
  it.each([
    ['ORGANIZATION_ARCHIVED', 'ORGANIZATION_ARCHIVED'],
    ['ORGANIZATION_ALREADY_ARCHIVED', 'ORGANIZATION_ALREADY_ARCHIVED'],
    ['ORGANIZATION_NOT_ARCHIVED', 'ORGANIZATION_NOT_ARCHIVED'],
  ])('%s → %s', (code, expected) => {
    expect(organizationErrorFrom(new ApiError(409, code))).toBe(expected);
  });
});

describe('failures with no code', () => {
  it('reads a rate limit off the status', () => {
    expect(organizationErrorFrom({ error: { status: 429 } })).toBe(
      'RATE_LIMITED',
    );
  });

  it('reads a refusal off the status', () => {
    expect(organizationErrorFrom({ error: { status: 403 } })).toBe('FORBIDDEN');
  });

  it('falls back to unknown for anything else the server said', () => {
    expect(organizationErrorFrom({ error: { status: 500 } })).toBe('UNKNOWN');
  });
});

describe('failures that never reached the server', () => {
  it('recognises the transport error type', () => {
    expect(organizationErrorFrom(new ApiUnavailableError())).toBe(
      'NETWORK_ERROR',
    );
  });

  it('recognises a bare fetch rejection', () => {
    // No status and no code is the signature of a request that did not
    // arrive — a different message and a different remedy.
    expect(organizationErrorFrom(new TypeError('fetch failed'))).toBe(
      'NETWORK_ERROR',
    );
  });

  it('treats a non-object as a transport failure rather than crashing', () => {
    expect(organizationErrorFrom(undefined)).toBe('NETWORK_ERROR');
    expect(organizationErrorFrom('boom')).toBe('NETWORK_ERROR');
  });
});

describe('the closed set', () => {
  it('never produces a state outside it', () => {
    const samples: unknown[] = [
      null,
      { error: { code: 'A_CODE_WE_HAVE_NEVER_SEEN' } },
      { error: { status: 418 } },
      new ApiError(500, undefined),
      new ApiUnavailableError(),
    ];

    for (const sample of samples) {
      expect(ORGANIZATION_ERRORS).toContain(organizationErrorFrom(sample));
    }
  });

  it('names its translation key predictably', () => {
    expect(organizationErrorKey('SLUG_TAKEN')).toBe('errors.SLUG_TAKEN');
  });
});
