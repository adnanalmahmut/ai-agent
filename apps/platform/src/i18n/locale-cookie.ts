import type { AppLocale } from '@repo/i18n-core';

import { LOCALE_COOKIE } from './config';

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
