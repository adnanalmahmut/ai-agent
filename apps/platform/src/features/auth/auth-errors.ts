export const AUTH_ERROR_CODES = [
  'INVALID_CREDENTIALS',
  'EMAIL_NOT_VERIFIED',
  'ACCOUNT_DEACTIVATED',
  'ACCOUNT_BANNED',
  'EMAIL_ALREADY_REGISTERED',
  'EMAIL_ALREADY_VERIFIED',
  'WEAK_PASSWORD',
  'INVALID_TOKEN',
  'TOKEN_EXPIRED',
  'PROVIDER_UNAVAILABLE',
  'ACCOUNT_LINK_CONFLICT',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'RATE_LIMITED',
  'NETWORK_ERROR',
  'UNKNOWN',
] as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

export const BACKEND_ERROR_CODES = {
  accountDeactivated: 'ACCOUNT_DEACTIVATED',
  organizationArchived: 'ORGANIZATION_ARCHIVED',
} as const;

const CODE_MAP: Readonly<Record<string, AuthErrorCode>> = {
  INVALID_EMAIL_OR_PASSWORD: 'INVALID_CREDENTIALS',
  INVALID_PASSWORD: 'INVALID_CREDENTIALS',
  INVALID_EMAIL: 'INVALID_CREDENTIALS',
  INVALID_USER: 'INVALID_CREDENTIALS',
  USER_NOT_FOUND: 'INVALID_CREDENTIALS',
  CREDENTIAL_ACCOUNT_NOT_FOUND: 'INVALID_CREDENTIALS',

  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  EMAIL_ALREADY_VERIFIED: 'EMAIL_ALREADY_VERIFIED',
  VERIFICATION_EMAIL_NOT_ENABLED: 'UNKNOWN',

  [BACKEND_ERROR_CODES.accountDeactivated]: 'ACCOUNT_DEACTIVATED',
  BANNED_USER: 'ACCOUNT_BANNED',

  USER_ALREADY_EXISTS: 'EMAIL_ALREADY_REGISTERED',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'EMAIL_ALREADY_REGISTERED',

  PASSWORD_TOO_SHORT: 'WEAK_PASSWORD',
  PASSWORD_TOO_LONG: 'WEAK_PASSWORD',

  INVALID_TOKEN: 'INVALID_TOKEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',

  PROVIDER_NOT_FOUND: 'PROVIDER_UNAVAILABLE',
  FAILED_TO_GET_USER_INFO: 'PROVIDER_UNAVAILABLE',
  ID_TOKEN_NOT_SUPPORTED: 'PROVIDER_UNAVAILABLE',

  SOCIAL_ACCOUNT_ALREADY_LINKED: 'ACCOUNT_LINK_CONFLICT',
  LINKED_ACCOUNT_ALREADY_EXISTS: 'ACCOUNT_LINK_CONFLICT',
  USER_EMAIL_NOT_FOUND: 'ACCOUNT_LINK_CONFLICT',

  SESSION_EXPIRED: 'UNAUTHENTICATED',
};

type AuthFailure = {
  code?: string | null;
  status?: number | null;
};

export function normalizeAuthError(input: unknown): AuthErrorCode {
  if (input === null || input === undefined) return 'UNKNOWN';

  const failure = readFailure(input);

  if (failure === null) return 'NETWORK_ERROR';

  if (failure.code) {
    const mapped = CODE_MAP[failure.code];
    if (mapped) return mapped;
  }

  return fromStatus(failure.status);
}

function readFailure(input: unknown): AuthFailure | null {
  if (typeof input !== 'object' || input === null) return null;

  const value = input as Record<string, unknown>;
  const source = isRecord(value.error) ? value.error : value;

  let code = typeof source.code === 'string' ? source.code : undefined;
  const status = typeof source.status === 'number' ? source.status : undefined;
  const message =
    typeof source.message === 'string' ? source.message : undefined;

  if (!code && message) {
    if (/invalid password/i.test(message)) code = 'INVALID_PASSWORD';
    else if (/invalid email or password/i.test(message))
      code = 'INVALID_EMAIL_OR_PASSWORD';
    else if (/user not found/i.test(message)) code = 'USER_NOT_FOUND';
    else if (/email not verified/i.test(message)) code = 'EMAIL_NOT_VERIFIED';
    else if (/account deactivated/i.test(message)) code = 'ACCOUNT_DEACTIVATED';
    else if (/banned/i.test(message)) code = 'BANNED_USER';
    else if (/already registered|already exists/i.test(message))
      code = 'USER_ALREADY_EXISTS';
  }

  if (code === undefined && status === undefined) return null;

  return { code, status };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function fromStatus(status: number | null | undefined): AuthErrorCode {
  if (status === 429) return 'RATE_LIMITED';
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';

  return 'UNKNOWN';
}

export function authErrorFromCallback(
  code: string | null | undefined,
): AuthErrorCode | null {
  if (!code) return null;

  return normalizeAuthError({ code });
}

export function authErrorMessageKey(code: AuthErrorCode): string {
  return `errors.${code}`;
}
