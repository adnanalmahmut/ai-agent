import type { authClient } from '@/features/auth/auth-client';

export const INVITATION_FAILURES = [
  'UNAVAILABLE',
  'WRONG_ACCOUNT',
  'EMAIL_VERIFICATION_REQUIRED',
  'ORGANIZATION_ARCHIVED',
  'ORGANIZATION_UNAVAILABLE',
  'INVITER_GONE',
  'MEMBERSHIP_LIMIT_REACHED',
  'FORBIDDEN',
  'NETWORK_ERROR',
  'UNKNOWN',
] as const;

export type InvitationFailure = (typeof INVITATION_FAILURES)[number];

export type InvitationDetails = NonNullable<
  Awaited<ReturnType<typeof authClient.organization.getInvitation>>['data']
>;

export type InvitationLookup =
  | { readonly ok: true; readonly invitation: InvitationDetails }
  | { readonly ok: false; readonly failure: InvitationFailure };

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

export function invitationFailureKey(failure: InvitationFailure): string {
  return `failures.${failure}`;
}
