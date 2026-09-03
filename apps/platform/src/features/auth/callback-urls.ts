import type { AppLocale } from '@repo/i18n-core';

import { PLATFORM_BASE_PATH } from '@/config/paths';
import { localizedPath } from '@/i18n/routing';

import { AUTH_ROUTES } from './routes';

/**
 * Absolute URLs handed to the backend as `callbackURL` / `redirectTo`.
 *
 * They must be absolute. Better Auth resolves a relative callback against its
 * *own* base URL, so a bare `/verify-email` would send the reader to the API
 * rather than back here — and under a single origin that mistake is invisible
 * in development until the path 404s.
 *
 * They must also carry both prefixes themselves. By the time the browser
 * follows one of these it has been through Google or an email client, neither
 * of which knows that this application is mounted at `/platform` or that its
 * locale lives in the path. Next's `basePath` only applies while the
 * application builds routes; it does not exist in an email.
 *
 * Every value produced here is checked by the backend against its
 * `trustedOrigins` before it is honoured, so this file decides where a
 * legitimate user lands, not what the backend is willing to redirect to.
 */

/** Marks an arrival that came *back* from the backend, not from sign-up. */
export const VERIFICATION_STATUS_PARAM = 'status';
export const VERIFICATION_STATUS_VERIFIED = 'verified';

/**
 * Better Auth appends this to a callback URL when the token was rejected —
 * `?error=TOKEN_EXPIRED`, `&error=INVALID_TOKEN`, and so on. The value is one
 * of its own error codes, which is why the pages read it through
 * `normalizeAuthError` rather than matching on text.
 */
export const CALLBACK_ERROR_PARAM = 'error';

/**
 * `origin` is a parameter rather than read from `window` so this stays a pure
 * function that a test can call without a DOM, and so the one place that
 * decides "which origin are we on" is the caller.
 */
export function absoluteAppUrl(
  href: string,
  locale: AppLocale,
  origin: string,
): string {
  const [path, query] = splitQuery(href);
  const pathname = `${PLATFORM_BASE_PATH}${localizedPath(locale, path)}`;

  return new URL(`${pathname}${query}`, origin).toString();
}

/** Where the emailed verification link comes back to. */
export function verificationCallbackUrl(locale: AppLocale, origin: string) {
  return absoluteAppUrl(
    `${AUTH_ROUTES.verifyEmail}?${VERIFICATION_STATUS_PARAM}=${VERIFICATION_STATUS_VERIFIED}`,
    locale,
    origin,
  );
}

/** Where the emailed password-reset link comes back to. */
export function passwordResetCallbackUrl(locale: AppLocale, origin: string) {
  return absoluteAppUrl(AUTH_ROUTES.resetPassword, locale, origin);
}

function splitQuery(href: string): [string, string] {
  const index = href.indexOf('?');

  return index === -1 ? [href, ''] : [href.slice(0, index), href.slice(index)];
}
