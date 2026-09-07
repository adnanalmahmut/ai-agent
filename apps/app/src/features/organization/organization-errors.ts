import { ApiError, ApiUnavailableError } from '@/lib/application-api';

export const ORGANIZATION_ERRORS = [
  'FORBIDDEN',
  'NOT_A_MEMBER',
  'ORGANIZATION_NOT_FOUND',
  'ORGANIZATION_ARCHIVED',
  'ORGANIZATION_NOT_ARCHIVED',
  'ORGANIZATION_ALREADY_ARCHIVED',
  'SLUG_TAKEN',
  'ORGANIZATION_LIMIT_REACHED',
  'MEMBER_NOT_FOUND',
  'MEMBER_LIMIT_REACHED',
  'ALREADY_A_MEMBER',
  'ALREADY_INVITED',
  'INVITATION_NOT_FOUND',
  'INVITATION_LIMIT_REACHED',
  'ROLE_NOT_ALLOWED',
  'LAST_OWNER',
  'EMAIL_VERIFICATION_REQUIRED',
  'PROFILE_CONFLICT',
  'RATE_LIMITED',
  'NETWORK_ERROR',
  'UNKNOWN',
] as const;

export type OrganizationError = (typeof ORGANIZATION_ERRORS)[number];

const CODE_MAP: Readonly<Record<string, OrganizationError>> = {
  // Permission. Better Auth phrases these per operation; the reader does not
  // care which verb was refused, only that it was.
  YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_ORGANIZATION: 'FORBIDDEN',
  YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_ORGANIZATION: 'FORBIDDEN',
  YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_ORGANIZATION: 'FORBIDDEN',
  YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION: 'FORBIDDEN',
  YOU_ARE_NOT_ALLOWED_TO_CANCEL_THIS_INVITATION: 'FORBIDDEN',
  YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER: 'FORBIDDEN',
  YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER: 'FORBIDDEN',
  YOU_ARE_NOT_ALLOWED_TO_ACCESS_THIS_ORGANIZATION: 'FORBIDDEN',

  // A role the caller may not hand out — a distinct remedy from "you may not
  // invite at all", so it gets its own state.
  YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE: 'ROLE_NOT_ALLOWED',
  ROLE_NOT_FOUND: 'ROLE_NOT_ALLOWED',

  USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION: 'NOT_A_MEMBER',
  YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION: 'NOT_A_MEMBER',

  ORGANIZATION_NOT_FOUND: 'ORGANIZATION_NOT_FOUND',
  NO_ACTIVE_ORGANIZATION: 'ORGANIZATION_NOT_FOUND',

  ORGANIZATION_ALREADY_EXISTS: 'SLUG_TAKEN',
  ORGANIZATION_SLUG_ALREADY_TAKEN: 'SLUG_TAKEN',

  YOU_HAVE_REACHED_THE_MAXIMUM_NUMBER_OF_ORGANIZATIONS:
    'ORGANIZATION_LIMIT_REACHED',
  ORGANIZATION_MEMBERSHIP_LIMIT_REACHED: 'MEMBER_LIMIT_REACHED',
  INVITATION_LIMIT_REACHED: 'INVITATION_LIMIT_REACHED',

  MEMBER_NOT_FOUND: 'MEMBER_NOT_FOUND',
  USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION: 'ALREADY_A_MEMBER',
  USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION: 'ALREADY_INVITED',
  INVITATION_NOT_FOUND: 'INVITATION_NOT_FOUND',

  YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER: 'LAST_OWNER',
  YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER: 'LAST_OWNER',

  EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION: 'EMAIL_VERIFICATION_REQUIRED',
  EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION:
    'EMAIL_VERIFICATION_REQUIRED',

  // This project's own backend, not Better Auth. Both halves of the archive
  // lifecycle report a machine-readable code the same way.
  ORGANIZATION_ARCHIVED: 'ORGANIZATION_ARCHIVED',
  ORGANIZATION_ALREADY_ARCHIVED: 'ORGANIZATION_ALREADY_ARCHIVED',
  ORGANIZATION_NOT_ARCHIVED: 'ORGANIZATION_NOT_ARCHIVED',
  NOT_FOUND: 'ORGANIZATION_NOT_FOUND',
  CONFLICT: 'PROFILE_CONFLICT',
};

export function organizationErrorFrom(input: unknown): OrganizationError {
  if (input instanceof ApiUnavailableError) return 'NETWORK_ERROR';

  if (input instanceof ApiError) {
    return fromCodeAndStatus(input.code, input.status);
  }

  if (typeof input !== 'object' || input === null) return 'NETWORK_ERROR';

  const value = input as Record<string, unknown>;
  const source =
    typeof value.error === 'object' && value.error !== null
      ? (value.error as Record<string, unknown>)
      : value;

  const code = typeof source.code === 'string' ? source.code : undefined;
  const status = typeof source.status === 'number' ? source.status : undefined;

  // Neither a code nor a status is the signature of a request that never
  // reached the server — a different message and a different remedy from
  // anything the server could have said.
  if (code === undefined && status === undefined) return 'NETWORK_ERROR';

  return fromCodeAndStatus(code, status);
}

function fromCodeAndStatus(
  code: string | undefined,
  status: number | undefined,
): OrganizationError {
  if (code) {
    const mapped = CODE_MAP[code];
    if (mapped) return mapped;
  }

  if (status === 429) return 'RATE_LIMITED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'ORGANIZATION_NOT_FOUND';

  return 'UNKNOWN';
}

export function organizationErrorKey(error: OrganizationError): string {
  return `errors.${error}`;
}
