import { NextRequest, NextResponse } from 'next/server';

import { LOCALE_COOKIE } from '@/i18n/config';
import { localeFallbackPath, localeFromPathname } from '@/i18n/routing';

/**
 * Locale resolution only. Every path carries its locale, so a request that
 * arrives without one is sent to the default locale's equivalent; a request
 * that has one gets the preference remembered.
 *
 * Nothing here decides access. The gate is the protected layout, on the
 * server, where the session can actually be read.
 */
export default function proxy(request: NextRequest) {
  const source = new URL(request.url);
  const locale = localeFromPathname(source.pathname);

  if (!locale) {
    const destination = new URL(
      localeFallbackPath(`${source.pathname}${source.search}`),
      source.origin,
    );

    return NextResponse.redirect(destination);
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-next-intl-locale', locale);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.cookies.set(LOCALE_COOKIE.name, locale, {
    maxAge: LOCALE_COOKIE.maxAgeSeconds,
    path: LOCALE_COOKIE.path,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  });

  return response;
}

export const config = {
  matcher: ['/', '/((?!api|health|_next|_vercel|.*\\..*).*)'],
};
