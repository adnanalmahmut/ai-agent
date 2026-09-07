import { NextRequest, NextResponse } from 'next/server';

import { PLATFORM_BASE_PATH } from '@/config/paths';
import { LOCALE_COOKIE } from '@/i18n/config';
import {
  localeFallbackPath,
  localeFromPathname,
  stripBasePath,
} from '@/i18n/routing';

export default function proxy(request: NextRequest) {
  const source = new URL(request.url);
  const applicationPath = stripBasePath(source.pathname);
  const locale = localeFromPathname(applicationPath);

  if (!locale) {
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
      `${PLATFORM_BASE_PATH}${localeFallbackPath(`${source.pathname}${source.search}`)}`,
      origin,
    );

    return NextResponse.redirect(destination);
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-next-intl-locale', locale);
  requestHeaders.set(
    'x-platform-return-to',
    `${source.pathname}${source.search}`,
  );
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
  matcher: ['/', '/((?!api|health|trpc|_next|_vercel|.*\\..*).*)'],
};
