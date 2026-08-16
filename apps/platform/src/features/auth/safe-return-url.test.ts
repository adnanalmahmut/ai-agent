import { describe, expect, it } from 'vitest';

import { stripLocalePrefix } from '@/i18n/routing';

import { PLATFORM_ROUTES } from './routes';
import { returnPathFromUrl, safeReturnPath } from './safe-return-url';

/**
 * The open-redirect guard.
 *
 * These are the tests that matter most in the feature: everything else here
 * fails visibly, while a hole in this function fails by working — the victim
 * signs in successfully and is then handed to whoever wrote the link.
 */
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
      // `URLSearchParams` hands values over decoded, so a literal space is a
      // legitimate thing to see here and must not be treated as an attack.
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
    ])('%s', (_name, input) => {
      expect(safeReturnPath(input)).toBe(PLATFORM_ROUTES.dashboard);
    });

    it('rejects a tab-smuggled authority', () => {
      // Browsers strip tab, LF and CR from URLs before resolving them, so
      // this becomes `//evil.example` after normalisation.
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
      // Public, but not an authentication route — signing in from an
      // invitation must come back to it.
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
    // Not a locale segment, despite the resemblance.
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
    // The proxy writes it, the sign-in page reads it back — the value has to
    // be stable under the validator that guards both ends.
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
