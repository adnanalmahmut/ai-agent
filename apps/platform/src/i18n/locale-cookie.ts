import type { AppLocale } from '@repo/i18n-core';

import { LOCALE_COOKIE } from './config';

/**
 * Persists the reader's language choice for the backend to find.
 *
 * next-intl wrote this cookie on every language switch, and removing it would
 * have been a silent regression rather than a simplification: the backend
 * reads `APP_LOCALE` as one candidate when deciding what language to send an
 * email in, so without it a verification link would arrive in whatever
 * language the *request* happened to suggest.
 *
 * It is a preference, never a routing input — nothing in this application
 * reads it back. The URL decides what the platform renders, always.
 *
 * Written with `document.cookie` because there is no server here to set a
 * header, and because a preference cookie is not a credential: it is
 * deliberately readable by script, unlike the session cookie, which this
 * application never touches.
 */
export function rememberLocale(locale: AppLocale): void {
  const parts = [
    `${LOCALE_COOKIE.name}=${locale}`,
    `Path=${LOCALE_COOKIE.path}`,
    `Max-Age=${LOCALE_COOKIE.maxAgeSeconds}`,
    `SameSite=${LOCALE_COOKIE.sameSite}`,
  ];

  // Only over TLS. A `Secure` cookie is simply dropped on plain http, which
  // would make the preference silently stop working in local development.
  if (window.location.protocol === 'https:') parts.push('Secure');

  document.cookie = parts.join('; ');
}
