import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isAppLocale,
  type AppLocale,
} from '@repo/i18n-core';
import { defineRouting } from 'next-intl/routing';

import { PLATFORM_BASE_PATH } from '@/config/paths';
import {
  LOCALE_COOKIE,
  LOCALE_DETECTION,
  LOCALE_PREFIX,
} from './config';

/** The single Next.js locale routing definition. */
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

/**
 * The URL grammar of the platform, as pure functions.
 *
 * Every path in this application has the same three parts:
 *
 *   /platform  /en           /organizations/abc/members?tab=active
 *   └ base     └ locale      └ application path
 *
 * Next applies `basePath` at the routing boundary, so application navigation
 * deals in locale-aware paths while request-boundary code still sees the real
 * browser URL. `stripBasePath` exists for those request and callback helpers.
 *
 * These are deliberately free of React and of the router: the redirect rules
 * they encode are the ones most worth testing, and a test should not need a
 * router to check that `/en` means English.
 */

/** Everything after the locale, for a path that has already lost its base. */
export function stripLocalePrefix(pathname: string): string {
  for (const locale of SUPPORTED_LOCALES) {
    if (pathname === `/${locale}`) return '/';
    if (pathname.startsWith(`/${locale}/`)) {
      return pathname.slice(locale.length + 1);
    }
  }

  return pathname;
}

/** The locale a path declares, or `undefined` if its first segment is not one. */
export function localeFromPathname(pathname: string): AppLocale | undefined {
  const segment = pathname.split('/')[1];

  return isAppLocale(segment) ? segment : undefined;
}

/**
 * Prefixes an application path with a locale.
 *
 * `/` is special-cased so the dashboard is `/en` rather than `/en/`, which the
 * router would otherwise treat as a separate URL and redirect away from.
 */
export function localizedPath(locale: AppLocale, href: string): string {
  const path = href.startsWith('/') ? href : `/${href}`;

  return path === '/' ? `/${locale}` : `/${locale}${path}`;
}

/**
 * Removes the application's configured mount point from a real browser
 * pathname.
 */
export function stripBasePath(
  pathname: string,
  base: string = PLATFORM_BASE_PATH,
): string {
  if (pathname === base) return '/';
  if (pathname.startsWith(`${base}/`)) return pathname.slice(base.length);

  return pathname;
}

/**
 * Where to send a request whose first segment is not a supported locale.
 *
 * Two cases arrive here and both are served by the same rule. A deep link that
 * simply omitted the locale (`/platform/organizations`) keeps its path and
 * gains the default one. A link naming a locale we do not support
 * (`/platform/fr/organizations`) is *also* prefixed, and then fails to match
 * any route — which is the honest outcome: we cannot serve French, and
 * silently rewriting it to Arabic would tell the reader we could.
 *
 * Deterministic either way, and never dependent on the browser's language: a
 * URL means the same thing to everyone who opens it.
 */
export function localeFallbackPath(
  pathname: string,
  base: string = PLATFORM_BASE_PATH,
): string {
  const path = stripBasePath(pathname, base);

  return localizedPath(DEFAULT_LOCALE, path);
}
