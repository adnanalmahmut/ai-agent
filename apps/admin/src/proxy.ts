import { NextRequest, NextResponse } from 'next/server';

import { ADMIN_BASE_PATH } from '@/config/paths';
import { LOCALE_COOKIE } from '@/i18n/config';
import {
  localeFallbackPath,
  localeFromPathname,
  stripBasePath,
} from '@/i18n/routing';

/**
 * Locale resolution only. Every path carries its locale, so a request that
 * arrives without one is sent to the default locale's equivalent; a request
 * that has one gets the preference remembered.
 *
 * Nothing here decides access. The gate is the protected layout, on the
 * server, where the session can actually be read.
 *
 * The base path is removed before the locale is read and put back on the
 * redirect, because middleware sees `request.url` with the mount point still
 * on it while the matcher above does not. Without that, `/admin/en/login`
 * would look like a request whose first segment is `admin` and be redirected
 * to a locale prefix in front of the mount point.
 */
export default function proxy(request: NextRequest) {
  const source = new URL(request.url);
  const applicationPath = stripBasePath(source.pathname);
  const locale = localeFromPathname(applicationPath);

  if (!locale) {
    // Built from the forwarded name rather than from `request.url`, which in
    // the standalone server is the address the gateway dialled. A redirect is
    // read by the browser, so it has to name the origin the browser is on --
    // and its scheme, or the answer to an HTTPS request would send the reader
    // to `http://` and rely on a second redirect to get back.
    const host = firstForwardedValue(
      request.headers.get('x-forwarded-host') ?? request.headers.get('host'),
    );
    const protocol = firstForwardedValue(
      request.headers.get('x-forwarded-proto'),
    );
    const origin = host
      ? `${protocol ?? source.protocol.replace(':', '')}://${host}`
      : source.origin;
    const destination = new URL(
      `${ADMIN_BASE_PATH}${localeFallbackPath(`${source.pathname}${source.search}`)}`,
      origin,
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

function firstForwardedValue(value: string | null): string | null {
  return value?.split(',')[0]?.trim() || null;
}

export const config = {
  matcher: ['/', '/((?!api|health|_next|_vercel|.*\\..*).*)'],
};
