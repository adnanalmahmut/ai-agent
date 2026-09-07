import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isAppLocale,
  type AppLocale,
} from '@repo/i18n-core';
import { defineRouting } from 'next-intl/routing';

import { LOCALE_COOKIE, LOCALE_DETECTION, LOCALE_PREFIX } from './config';

export const routing = defineRouting({
  locales: SUPPORTED_LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: LOCALE_PREFIX,
  localeDetection: LOCALE_DETECTION,
  localeCookie: {
    name: LOCALE_COOKIE.name,
    path: LOCALE_COOKIE.path,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: LOCALE_COOKIE.maxAgeSeconds,
  },
  alternateLinks: false,
});

export function localeFromPathname(pathname: string): AppLocale | undefined {
  const segment = pathname.split('/')[1];

  return isAppLocale(segment) ? segment : undefined;
}

export function localizedPath(locale: AppLocale, href: string): string {
  const path = href.startsWith('/') ? href : `/${href}`;

  return path === '/' ? `/${locale}` : `/${locale}${path}`;
}

export function localeFallbackPath(pathname: string): string {
  return localizedPath(DEFAULT_LOCALE, pathname);
}
