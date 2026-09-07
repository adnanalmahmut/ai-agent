import { describe, expect, it } from 'vitest';

import { stripLocalePrefix } from '@/i18n/routing';

import { PLATFORM_ROUTES } from './routes';
import { returnPathFromUrl, safeReturnPath } from './safe-return-url';

describe('safeReturnPath', () => {
  describe('accepts internal destinations', () => {
    it.each([
      ['/', '/'],
      ['/reports', '/reports'],
      ['/reports/2026', '/reports/2026'],
      ['/reports?filter=x&page=2', '/reports?filter=x&page=2'],
      ['/reports#section', '/reports#section'],
      ['/reports?filter=x#section', '/reports?filter=x#section'],
    ])('%s', (input, expected) => {
      expect(safeReturnPath(input)).toBe(expected);
    });

    it('keeps a spaces-containing query value', () => {
      expect(safeReturnPath('/search?q=design system')).toBe(
        '/search?q=design%20system',
      );
    });
  });

  describe('rejects anything that leaves the application', () => {
    it.each([
      ['absolute https', 'https://evil.example'],
      ['absolute http', 'http://evil.example/path'],
      ['protocol-relative', '//evil.example'],
      ['protocol-relative with path', '//evil.example/reports'],
      ['javascript scheme', 'javascript:alert(1)'],
      ['data scheme', 'data:text/html,<script>alert(1)</script>'],
      ['vbscript scheme', 'vbscript:msgbox(1)'],
      ['mailto', 'mailto:someone@evil.example'],
      ['backslash authority', '/\\evil.example'],
      ['double backslash', '\\\\evil.example'],
      ['scheme-relative with credentials', '//user:pass@evil.example'],
      ['bare word', 'reports'],
      ['empty', ''],
      ['whitespace only', '   '],
      // Prefix confusion: a host that begins with, or merely contains, the
      // real one. A check written as `startsWith(origin)` accepts the first
      // of these, which is why this one is not written that way.
      ['a host prefixed by the real one', 'https://app.example.com.evil.example/x'],
      ['userinfo hiding the real host', 'https://app.example.com@evil.example/x'],
      ['userinfo with a port', 'https://app.example.com:443@evil.example/x'],
      ['an encoded absolute URL', 'https%3A%2F%2Fevil.example'],
      ['a triple-slash authority', '///evil.example'],
      ['a scheme with mixed case', 'JavaScript:alert(1)'],
    ])('%s', (_name, input) => {
      expect(safeReturnPath(input)).toBe(PLATFORM_ROUTES.dashboard);
    });

    it('keeps an encoded authority on this origin instead of rejecting it', () => {
      // `/%2f%2fevil.example` is a path whose first segment happens to read
      // like an authority. A browser does not decode `%2f` while resolving,
      // so this navigates to a page on this origin that does not exist —
      // which is a 404, not a redirect off the site. Kept rather than
      // rejected because the check answers "does this leave the
      // application", and this does not.
      expect(safeReturnPath('/%2f%2fevil.example')).toBe(
        '/%2f%2fevil.example',
      );
    });

    it('rejects a tab-smuggled authority', () => {
      expect(safeReturnPath('/\t/evil.example')).toBe(
        PLATFORM_ROUTES.dashboard,
      );
      expect(safeReturnPath('/\n/evil.example')).toBe(
        PLATFORM_ROUTES.dashboard,
      );
      expect(safeReturnPath('/\r/evil.example')).toBe(
        PLATFORM_ROUTES.dashboard,
      );
    });

    it('rejects a non-string', () => {
      expect(safeReturnPath(undefined)).toBe(PLATFORM_ROUTES.dashboard);
      expect(safeReturnPath(null)).toBe(PLATFORM_ROUTES.dashboard);
    });

    it('rejects an implausibly long value', () => {
      expect(safeReturnPath(`/${'a'.repeat(4000)}`)).toBe(
        PLATFORM_ROUTES.dashboard,
      );
    });
  });

  describe('avoids redirect loops', () => {
    it.each([
      '/sign-in',
      '/sign-up',
      '/sign-in?returnTo=/reports',
      '/reset-password',
      '/verify-email',
      '/forgot-password',
    ])('never returns to %s', (input) => {
      expect(safeReturnPath(input)).toBe(PLATFORM_ROUTES.dashboard);
    });

    it('does not mistake a lookalike path for an auth route', () => {
      expect(safeReturnPath('/sign-in-report')).toBe('/sign-in-report');
    });

    it('still allows returning to the invitation page', () => {
      expect(safeReturnPath('/organizations/accept-invitation?id=abc')).toBe(
        '/organizations/accept-invitation?id=abc',
      );
    });
  });

  it('honours an explicit fallback', () => {
    expect(safeReturnPath('https://evil.example', '/reports')).toBe('/reports');
  });
});

describe('stripLocalePrefix', () => {
  it.each([
    ['/en/reports', '/reports'],
    ['/ar/reports', '/reports'],
    ['/en', '/'],
    ['/ar', '/'],
    ['/reports', '/reports'],
    ['/english/reports', '/english/reports'],
    ['/enterprise', '/enterprise'],
  ])('%s becomes %s', (input, expected) => {
    expect(stripLocalePrefix(input)).toBe(expected);
  });
});

describe('returnPathFromUrl', () => {
  it('keeps the query and drops the locale prefix', () => {
    expect(
      returnPathFromUrl({ pathname: '/ar/reports/2026', search: '?filter=x' }),
    ).toBe('/reports/2026?filter=x');
  });

  it('produces a value that survives a second pass', () => {
    const once = returnPathFromUrl({
      pathname: '/en/reports',
      search: '?a=1&b=2',
    });

    expect(safeReturnPath(once)).toBe(once);
  });

  it('falls back for a locale-prefixed sign-in page', () => {
    expect(returnPathFromUrl({ pathname: '/en/sign-in', search: '' })).toBe(
      PLATFORM_ROUTES.dashboard,
    );
  });
});
