import type { authClient } from '@/features/auth/auth-client';

/**
 * Interpretation of an invitation, kept away from the components that render
 * it.
 *
 * The states below are the ones the backend can actually distinguish — no
 * more. That matters most where it is inconvenient: an invitation that has
 * expired, one that was cancelled, and one that was already accepted all come
 * back as the same `BAD_REQUEST` from `/organization/get-invitation`, because
 * telling them apart would let anyone holding an invitation id probe its
 * history. So they share one state, `UNAVAILABLE`, whose copy names the three
 * possibilities rather than guessing at one.
 *
 * The rest are genuinely distinguishable and each gets a state, because each
 * has a different remedy: sign in as someone else, verify your address, ask
 * for the organization to be restored.
 */

export const INVITATION_FAILURES = [
  /** Expired, cancelled, or already accepted — indistinguishable by design. */
  'UNAVAILABLE',
  /** Signed in, but as a different person than the one invited. */
  'WRONG_ACCOUNT',
  'EMAIL_VERIFICATION_REQUIRED',
  /** This project's own backend hook refuses work on an archived org. */
  'ORGANIZATION_ARCHIVED',
  'ORGANIZATION_UNAVAILABLE',
  'INVITER_GONE',
  'MEMBERSHIP_LIMIT_REACHED',
  'FORBIDDEN',
  'NETWORK_ERROR',
  'UNKNOWN',
] as const;

export type InvitationFailure = (typeof INVITATION_FAILURES)[number];

/**
 * What `/organization/get-invitation` returns on success.
 *
 * Read off the client rather than written out: the endpoint composes its
 * response from three tables (`invitation`, `organization`, the inviter's
 * `user`) and a hand-copied shape would be a second opinion about it.
 */
export type InvitationDetails = NonNullable<
  Awaited<ReturnType<typeof authClient.organization.getInvitation>>['data']
>;

export type InvitationLookup =
  | { readonly ok: true; readonly invitation: InvitationDetails }
  | { readonly ok: false; readonly failure: InvitationFailure };

/**
 * Codes from the organization plugin (`plugins/organization/error-codes.mjs`)
 * and from this project's archived-organization hook. Read by code, never by
 * message: the strings are English copy and change between versions.
 */
const CODE_MAP: Readonly<Record<string, InvitationFailure>> = {
  INVITATION_NOT_FOUND: 'UNAVAILABLE',
  YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION: 'WRONG_ACCOUNT',
  EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION: 'EMAIL_VERIFICATION_REQUIRED',
  EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION:
    'EMAIL_VERIFICATION_REQUIRED',
  ORGANIZATION_ARCHIVED: 'ORGANIZATION_ARCHIVED',
  ORGANIZATION_NOT_FOUND: 'ORGANIZATION_UNAVAILABLE',
  INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION: 'INVITER_GONE',
  ORGANIZATION_MEMBERSHIP_LIMIT_REACHED: 'MEMBERSHIP_LIMIT_REACHED',
  FAILED_TO_RETRIEVE_INVITATION: 'UNAVAILABLE',
};

export function invitationFailureFrom(input: unknown): InvitationFailure {
  if (typeof input !== 'object' || input === null) return 'NETWORK_ERROR';

  const value = input as Record<string, unknown>;
  const source =
    typeof value.error === 'object' && value.error !== null
      ? (value.error as Record<string, unknown>)
      : value;

  const code = typeof source.code === 'string' ? source.code : undefined;
  const status = typeof source.status === 'number' ? source.status : undefined;

  if (code === undefined && status === undefined) return 'NETWORK_ERROR';

  if (code) {
    const mapped = CODE_MAP[code];
    if (mapped) return mapped;
  }

  // `get-invitation` rejects an expired, cancelled or accepted invitation with
  // a bare 400 and no code at all — the single most common failure here, and
  // the reason this falls through to a status check rather than to UNKNOWN.
  if (status === 400) return 'UNAVAILABLE';
  if (status === 403) return 'FORBIDDEN';

  return 'UNKNOWN';
}

/** Translation key for a failure state, under `Organization.invitation`. */
export function invitationFailureKey(failure: InvitationFailure): string {
  return `failures.${failure}`;
}
