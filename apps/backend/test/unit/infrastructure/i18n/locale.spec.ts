import { describe, expect, it } from '@jest/globals';
import type { ExecutionContext } from '@nestjs/common';

import { AppLocaleResolver } from '../../../../src/infrastructure/i18n/app-locale.resolver';
import { resolveOutboundLocale } from '../../../../src/infrastructure/i18n/outbound-locale';
import {
  localeFromAcceptLanguage,
  localeFromAppHeader,
  localeFromCookieHeader,
  nodeHeaderGetter,
  resolveLocaleFromHeaders,
  webHeaderGetter,
} from '../../../../src/infrastructure/i18n/request-locale';
const get = (headers: Record<string, string | string[] | undefined>) =>
  nodeHeaderGetter(headers);

describe('request locale precedence', () => {
  describe('resolveLocaleFromHeaders', () => {
    it('lets X-App-Locale win over every other source', () => {
      expect(
        resolveLocaleFromHeaders(
          get({
            'x-app-locale': 'ar',
            cookie: 'APP_LOCALE=en',
            'accept-language': 'en',
          }),
          'en',
        ),
      ).toBe('ar');
    });

    it('lets an explicit header override the stored user preference', () => {
      expect(
        resolveLocaleFromHeaders(get({ 'x-app-locale': 'ar' }), 'en'),
      ).toBe('ar');
    });

    it('uses the user preference when no explicit header is sent', () => {
      expect(
        resolveLocaleFromHeaders(
          get({ cookie: 'APP_LOCALE=ar', 'accept-language': 'ar' }),
          'en',
        ),
      ).toBe('en');
    });

    it('lets the user preference win over the cookie', () => {
      expect(
        resolveLocaleFromHeaders(get({ cookie: 'APP_LOCALE=ar' }), 'en'),
      ).toBe('en');
    });

    it('falls back to the cookie when there is no user preference', () => {
      expect(
        resolveLocaleFromHeaders(
          get({ cookie: 'APP_LOCALE=en', 'accept-language': 'ar' }),
        ),
      ).toBe('en');
    });

    it('falls back to accept-language last', () => {
      expect(resolveLocaleFromHeaders(get({ 'accept-language': 'en' }))).toBe(
        'en',
      );
    });

    it('yields nothing when no candidate is present', () => {
      expect(resolveLocaleFromHeaders(get({}))).toBeUndefined();
    });

    describe('invalid candidates', () => {
      it('ignores an unsupported header and continues to the user preference', () => {
        expect(
          resolveLocaleFromHeaders(get({ 'x-app-locale': 'klingon' }), 'en'),
        ).toBe('en');
      });

      it('ignores an unsupported user preference and continues to the cookie', () => {
        expect(
          resolveLocaleFromHeaders(get({ cookie: 'APP_LOCALE=en' }), 'fr'),
        ).toBe('en');
      });

      it('yields nothing when every candidate is unsupported', () => {
        expect(
          resolveLocaleFromHeaders(
            get({
              'x-app-locale': 'klingon',
              cookie: 'APP_LOCALE=fr',
              'accept-language': 'de',
            }),
            'zh',
          ),
        ).toBeUndefined();
      });
    });
  });

  describe('individual sources', () => {
    it('reads a repeated header from its first value', () => {
      expect(localeFromAppHeader(get({ 'x-app-locale': ['en', 'ar'] }))).toBe(
        'en',
      );
    });

    it('finds the locale cookie among others', () => {
      expect(
        localeFromCookieHeader(
          get({ cookie: 'session=abc; APP_LOCALE=en; theme=dark' }),
        ),
      ).toBe('en');
    });

    it('survives a malformed cookie value instead of throwing', () => {
      expect(
        localeFromCookieHeader(get({ cookie: 'APP_LOCALE=%ZZ' })),
      ).toBeUndefined();
    });

    it('picks the highest-quality supported accept-language entry', () => {
      expect(
        localeFromAcceptLanguage(
          get({ 'accept-language': 'fr;q=1.0, en-GB;q=0.9, ar;q=0.2' }),
        ),
      ).toBe('en');
    });

    it('narrows a regional tag to its primary subtag', () => {
      expect(
        localeFromAcceptLanguage(get({ 'accept-language': 'ar-SA' })),
      ).toBe('ar');
    });
  });

  describe('web request adapter', () => {
    const webRequest = (headers: Record<string, string>) =>
      webHeaderGetter({ headers: new Headers(headers) });

    it('applies the same precedence to a Web-Fetch request', () => {
      expect(
        resolveLocaleFromHeaders(
          webRequest({
            'x-app-locale': 'ar',
            cookie: 'APP_LOCALE=en',
          }),
          'en',
        ),
      ).toBe('ar');
    });

    it('reads cookies and accept-language from Web headers', () => {
      expect(
        resolveLocaleFromHeaders(webRequest({ cookie: 'APP_LOCALE=en' })),
      ).toBe('en');
      expect(
        resolveLocaleFromHeaders(webRequest({ 'accept-language': 'en' })),
      ).toBe('en');
    });

    it('tolerates a callback invoked without a request', () => {
      expect(
        resolveLocaleFromHeaders(webHeaderGetter(undefined)),
      ).toBeUndefined();
    });
  });
});

type RequestShape = {
  headers: Record<string, string | undefined>;
  user?: { preferredLanguage?: unknown } | null;
};

function httpContext(request: Partial<RequestShape>): ExecutionContext {
  const built: RequestShape = { headers: {}, ...request };

  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => built }),
  } as unknown as ExecutionContext;
}

describe('AppLocaleResolver', () => {
  const resolver = new AppLocaleResolver();

  describe('precedence', () => {
    it('prefers X-App-Locale over every other source', () => {
      const locale = resolver.resolve(
        httpContext({
          headers: {
            'x-app-locale': 'en',
            cookie: 'APP_LOCALE=ar',
            'accept-language': 'ar',
          },
          user: { preferredLanguage: 'ar' },
        }),
      );

      expect(locale).toBe('en');
    });

    it("falls back to the authenticated user's preference when no header is sent", () => {
      const locale = resolver.resolve(
        httpContext({
          headers: { cookie: 'APP_LOCALE=ar', 'accept-language': 'ar' },
          user: { preferredLanguage: 'en' },
        }),
      );

      expect(locale).toBe('en');
    });

    it('prefers the cookie over accept-language', () => {
      const locale = resolver.resolve(
        httpContext({
          headers: { cookie: 'APP_LOCALE=en', 'accept-language': 'ar' },
        }),
      );

      expect(locale).toBe('en');
    });

    it('uses accept-language when nothing more explicit is present', () => {
      const locale = resolver.resolve(
        httpContext({ headers: { 'accept-language': 'en' } }),
      );

      expect(locale).toBe('en');
    });

    it('resolves nothing when the request carries no locale signal', () => {
      expect(resolver.resolve(httpContext({}))).toBeUndefined();
    });
  });

  describe('rejecting unsupported values', () => {
    it('ignores an unsupported header and continues down the chain', () => {
      const locale = resolver.resolve(
        httpContext({
          headers: { 'x-app-locale': 'klingon', 'accept-language': 'en' },
        }),
      );

      expect(locale).toBe('en');
    });

    it('ignores an unsupported cookie value', () => {
      const locale = resolver.resolve(
        httpContext({
          headers: { cookie: 'APP_LOCALE=fr', 'accept-language': 'en' },
        }),
      );

      expect(locale).toBe('en');
    });

    it('ignores an unsupported stored user preference', () => {
      const locale = resolver.resolve(
        httpContext({
          headers: { 'accept-language': 'en' },
          user: { preferredLanguage: 'de' },
        }),
      );

      expect(locale).toBe('en');
    });

    it('resolves nothing when every candidate is unsupported', () => {
      const locale = resolver.resolve(
        httpContext({
          headers: {
            'x-app-locale': 'klingon',
            cookie: 'APP_LOCALE=fr',
            'accept-language': 'de,fr;q=0.8',
          },
        }),
      );

      expect(locale).toBeUndefined();
    });
  });

  describe('accept-language parsing', () => {
    it('narrows a regional tag to its primary subtag', () => {
      expect(
        resolver.resolve(
          httpContext({ headers: { 'accept-language': 'en-US,en;q=0.9' } }),
        ),
      ).toBe('en');
    });

    it('skips unsupported languages to reach a supported lower-quality one', () => {
      expect(
        resolver.resolve(
          httpContext({
            headers: { 'accept-language': 'fr-FR,de;q=0.9,en;q=0.5' },
          }),
        ),
      ).toBe('en');
    });

    it('honours quality ordering rather than document order', () => {
      expect(
        resolver.resolve(
          httpContext({ headers: { 'accept-language': 'en;q=0.4,ar;q=0.9' } }),
        ),
      ).toBe('ar');
    });

    it('ignores entries explicitly refused with q=0', () => {
      expect(
        resolver.resolve(
          httpContext({ headers: { 'accept-language': 'en;q=0,ar;q=0.3' } }),
        ),
      ).toBe('ar');
    });
  });

  describe('non-http contexts', () => {
    it('declines to resolve outside of an HTTP request', () => {
      const context = {
        getType: () => 'rpc',
      } as unknown as ExecutionContext;

      expect(resolver.resolve(context)).toBeUndefined();
    });
  });

  describe('cookie parsing', () => {
    it('reads APP_LOCALE from a multi-cookie header', () => {
      const locale = resolver.resolve(
        httpContext({
          headers: { cookie: 'theme=dark; APP_LOCALE=en; session=abc123' },
        }),
      );

      expect(locale).toBe('en');
    });

    it('ignores a malformed percent-escape instead of throwing', () => {
      const locale = resolver.resolve(
        httpContext({
          headers: { cookie: 'APP_LOCALE=%ZZ', 'accept-language': 'en' },
        }),
      );

      expect(locale).toBe('en');
    });

    it('ignores a cookie header with no APP_LOCALE entry', () => {
      expect(
        resolver.resolve(
          httpContext({ headers: { cookie: 'theme=dark; session=abc' } }),
        ),
      ).toBeUndefined();
    });
  });
});

describe('resolveOutboundLocale', () => {
  it('prefers an explicitly requested locale', () => {
    expect(
      resolveOutboundLocale({
        requested: 'en',
        userPreferred: 'ar',
        requestLocale: 'ar',
      }),
    ).toBe('en');
  });

  it("falls back to the recipient's stored preference", () => {
    expect(
      resolveOutboundLocale({ userPreferred: 'en', requestLocale: 'ar' }),
    ).toBe('en');
  });

  it('falls back to the locale of the originating request', () => {
    expect(resolveOutboundLocale({ requestLocale: 'en' })).toBe('en');
  });

  it('defaults to Arabic when no candidate is available', () => {
    expect(resolveOutboundLocale({})).toBe('ar');
  });

  it('never yields an unsupported locale', () => {
    expect(
      resolveOutboundLocale({
        requested: 'klingon',
        userPreferred: 'fr',
        requestLocale: 'de',
      }),
    ).toBe('ar');
  });

  it('skips an invalid candidate in favour of a valid lower-priority one', () => {
    expect(
      resolveOutboundLocale({ requested: 'fr', userPreferred: 'en' }),
    ).toBe('en');
  });

  it('ignores non-string candidates', () => {
    expect(
      resolveOutboundLocale({
        requested: null,
        userPreferred: undefined,
        requestLocale: 42,
      }),
    ).toBe('ar');
  });

  it('is deterministic, so a retry resolves the same locale as the first attempt', () => {
    const payloadInputs = { requested: 'en' as const };

    const first = resolveOutboundLocale(payloadInputs);
    const retry = resolveOutboundLocale(payloadInputs);

    expect(retry).toBe(first);
  });
});
