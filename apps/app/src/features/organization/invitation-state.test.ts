import { ORGANIZATION_ERROR_CODES } from 'better-auth/client/plugins';
import { describe, expect, it } from 'vitest';

import { BACKEND_ERROR_CODES } from '@/features/auth/auth-errors';

import {
  INVITATION_FAILURES,
  type InvitationFailure,
  invitationFailureFrom,
  invitationFailureKey,
} from './invitation-state';

describe('invitationFailureFrom', () => {
  it.each<[string, InvitationFailure]>([
    [ORGANIZATION_ERROR_CODES.INVITATION_NOT_FOUND.code, 'UNAVAILABLE'],
    [
      ORGANIZATION_ERROR_CODES.YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION.code,
      'WRONG_ACCOUNT',
    ],
    [
      ORGANIZATION_ERROR_CODES.EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION.code,
      'EMAIL_VERIFICATION_REQUIRED',
    ],
    [
      ORGANIZATION_ERROR_CODES
        .EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION
        .code,
      'EMAIL_VERIFICATION_REQUIRED',
    ],
    [
      ORGANIZATION_ERROR_CODES.ORGANIZATION_NOT_FOUND.code,
      'ORGANIZATION_UNAVAILABLE',
    ],
    [
      ORGANIZATION_ERROR_CODES.INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION
        .code,
      'INVITER_GONE',
    ],
    [
      ORGANIZATION_ERROR_CODES.ORGANIZATION_MEMBERSHIP_LIMIT_REACHED.code,
      'MEMBERSHIP_LIMIT_REACHED',
    ],
  ])('maps %s', (code, expected) => {
    expect(invitationFailureFrom({ error: { code, status: 400 } })).toBe(
      expected,
    );
  });

  it('recognises the archived-organization refusal from this backend', () => {
    expect(
      invitationFailureFrom({
        error: {
          code: BACKEND_ERROR_CODES.organizationArchived,
          status: 403,
        },
      }),
    ).toBe('ORGANIZATION_ARCHIVED');
  });

  it('treats a bare 400 as an unusable invitation', () => {
    expect(invitationFailureFrom({ error: { status: 400 } })).toBe(
      'UNAVAILABLE',
    );
  });

  it('does not pretend to tell expired from cancelled from accepted', () => {
    const failures = new Set(
      [400, 400, 400].map((status) =>
        invitationFailureFrom({ error: { status } }),
      ),
    );

    expect([...failures]).toEqual(['UNAVAILABLE']);
  });

  it('falls back to a forbidden state for an unmapped 403', () => {
    expect(invitationFailureFrom({ error: { status: 403 } })).toBe('FORBIDDEN');
  });

  it('reports an unreachable server as a network failure', () => {
    expect(invitationFailureFrom(new TypeError('Failed to fetch'))).toBe(
      'NETWORK_ERROR',
    );
    expect(invitationFailureFrom(null)).toBe('NETWORK_ERROR');
  });

  it('never returns a state outside the closed set', () => {
    for (const input of [
      undefined,
      {},
      { error: { status: 500 } },
      { code: 'SOMETHING_NEW', status: 418 },
    ]) {
      expect(INVITATION_FAILURES).toContain(invitationFailureFrom(input));
    }
  });
});

describe('invitationFailureKey', () => {
  it('produces a distinct key per failure', () => {
    const keys = INVITATION_FAILURES.map(invitationFailureKey);

    expect(new Set(keys).size).toBe(INVITATION_FAILURES.length);
  });
});
