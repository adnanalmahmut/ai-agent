import { describe, expect, it } from '@jest/globals';
import type { ExecutionContext } from '@nestjs/common';

import { AppLocaleResolver } from './app-locale.resolver';

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
      // `undefined` hands control to the configured fallbackLanguage (`ar`)
      // rather than this resolver hard-coding the default itself.
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
      // `decodeURIComponent('%ZZ')` raises URIError; an unreadable preference
      // cookie must never fail the request.
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
