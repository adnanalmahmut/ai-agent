import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isAppLocale,
  type AppLocale,
} from '@repo/i18n-core';
import { defineRouting } from 'next-intl/routing';

import { ADMIN_BASE_PATH } from '@/config/paths';

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

/**
 * The path this application's own router works in, with the mount point
 * removed.
 *
 * Next.js is inconsistent about this on purpose: a middleware matcher and a
 * route handler are given the path relative to `basePath`, while
 * `request.url` in middleware still carries it. Removing it here is therefore
 * conditional rather than unconditional, so the same code is correct whichever
 * of the two it is handed.
 */
export function stripBasePath(
  pathname: string,
  base: string = ADMIN_BASE_PATH,
): string {
  if (pathname === base) return '/';
  if (pathname.startsWith(`${base}/`)) return pathname.slice(base.length);

  return pathname;
}

export function localeFallbackPath(
  pathname: string,
  base: string = ADMIN_BASE_PATH,
): string {
  return localizedPath(DEFAULT_LOCALE, stripBasePath(pathname, base));
}
