/**
 * Turns whatever an auth call failed with into one of a small, closed set of
 * states the UI knows how to render.
 *
 * Two rules hold this together.
 *
 * **Never branch on a message.** Better Auth's English strings are copy, not
 * contract: they change between versions and they are the wrong language for
 * half our users. Every branch below reads a machine-readable `code` or an
 * HTTP status.
 *
 * **Never invent a code.** Every constant on the left of the map below exists
 * in the installed Better Auth 1.6.27 (`BASE_ERROR_CODES`, the admin plugin's
 * and the organization plugin's error codes) or is emitted by this project's
 * own backend hooks. Nothing here is aspirational.
 */

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

/**
 * Codes emitted by this project's backend, outside Better Auth's own set.
 *
 * `ACCOUNT_DEACTIVATED` comes from `databaseHooks.session.create.before`;
 * `ORGANIZATION_ARCHIVED` from the archived-organization request hook. Both
 * are string constants in `apps/backend/src/core/auth/auth-hooks.ts` and are
 * part of the contract between the two applications.
 */
export const BACKEND_ERROR_CODES = {
  accountDeactivated: 'ACCOUNT_DEACTIVATED',
  organizationArchived: 'ORGANIZATION_ARCHIVED',
} as const;

/**
 * Every credential-shaped failure collapses to one state.
 *
 * Distinguishing "no such user" from "wrong password" would turn the sign-in
 * form into an account-existence oracle. The backend already refuses to make
 * that distinction; this keeps the UI from re-introducing it.
 */
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

/** The slice of a Better Auth / better-fetch failure that is worth reading. */
type AuthFailure = {
  code?: string | null;
  status?: number | null;
};

/**
 * Reads a failure without trusting its shape.
 *
 * A rejected call can hand back a `BetterFetchError`, the `{ error }` half of
 * a `{ data, error }` response, or — when the network itself failed — a plain
 * `TypeError` with no status at all. `unknown` in, a closed union out.
 */
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

/**
 * `null` means "this never reached the server": no status and no code is the
 * signature of a fetch rejection — DNS failure, the API being down, an
 * offline browser — which is a different message and a different remedy from
 * anything the server could have said.
 */
function readFailure(input: unknown): AuthFailure | null {
  if (typeof input !== 'object') return null;

  const value = input as Record<string, unknown>;
  const source = isRecord(value.error) ? value.error : value;

  const code = typeof source.code === 'string' ? source.code : undefined;
  const status = typeof source.status === 'number' ? source.status : undefined;

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

/**
 * Reads the `?error=` a Better Auth redirect leaves behind.
 *
 * The value is one of its own codes — `TOKEN_EXPIRED`, `INVALID_TOKEN`,
 * `EMAIL_ALREADY_VERIFIED` — appended when a callback URL is reached after a
 * failure. `null` in means "no failure", not "unknown failure", so the caller
 * can tell an ordinary arrival from a rejected one.
 */
export function authErrorFromCallback(
  code: string | null | undefined,
): AuthErrorCode | null {
  if (!code) return null;

  return normalizeAuthError({ code });
}

/**
 * The translation key for an error state.
 *
 * Kept next to the mapping rather than inside a component so that adding a
 * state is one edit in one file, and so no component ever holds a string.
 */
export function authErrorMessageKey(code: AuthErrorCode): string {
  return `errors.${code}`;
}
