import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isAppLocale,
  type AppLocale,
} from '@repo/i18n-core';
import { defineRouting } from 'next-intl/routing';

import { PLATFORM_BASE_PATH } from '@/config/paths';
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

export function stripLocalePrefix(pathname: string): string {
  for (const locale of SUPPORTED_LOCALES) {
    if (pathname === `/${locale}`) return '/';
    if (pathname.startsWith(`/${locale}/`)) {
      return pathname.slice(locale.length + 1);
    }
  }

  return pathname;
}

export function localeFromPathname(pathname: string): AppLocale | undefined {
  const segment = pathname.split('/')[1];

  return isAppLocale(segment) ? segment : undefined;
}

export function localizedPath(locale: AppLocale, href: string): string {
  const path = href.startsWith('/') ? href : `/${href}`;

  return path === '/' ? `/${locale}` : `/${locale}${path}`;
}

export function stripBasePath(
  pathname: string,
  base: string = PLATFORM_BASE_PATH,
): string {
  if (pathname === base) return '/';
  if (pathname.startsWith(`${base}/`)) return pathname.slice(base.length);

  return pathname;
}

export function localeFallbackPath(
  pathname: string,
  base: string = PLATFORM_BASE_PATH,
): string {
  const path = stripBasePath(pathname, base);

  return localizedPath(DEFAULT_LOCALE, path);
}
