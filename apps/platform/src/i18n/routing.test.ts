import {
  DEFAULT_LOCALE,
  LOCALE_META,
  SUPPORTED_LOCALES,
} from '@repo/i18n-core';
import { describe, expect, it } from 'vitest';

import { PLATFORM_BASE_PATH } from '@/config/paths';

import { LOCALE_COOKIE, LOCALE_DETECTION, LOCALE_PREFIX } from './config';
import {
  localeFallbackPath,
  localeFromPathname,
  localizedPath,
  stripBasePath,
  stripLocalePrefix,
} from './routing';

/**
 * The URL grammar.
 *
 * These are pure functions over strings, which is the whole reason they exist
 * as a module: the rules they encode — where the locale sits, what happens
 * when it is missing, how the mount point is added and removed — decide every
 * redirect in the application, and they are worth checking without a router.
 */
describe('routing policy', () => {
  it('always carries the locale in the path', () => {
    // The router matches on a real `:locale` segment; "sometimes absent" would
    // make `/organizations` indistinguishable from a locale named that.
    expect(LOCALE_PREFIX).toBe('always');
  });

  it('never lets the browser or a cookie choose the locale', () => {
    // Project policy: a link shared between two people shows them the same
    // page. This must not become environment-dependent.
    expect(LOCALE_DETECTION).toBe(false);
  });

  it('keeps the locale cookie as a preference the backend reads', () => {
    expect(LOCALE_COOKIE.name).toBe('APP_LOCALE');
    // Scoped to the whole origin, because the reader is the API at `/api`.
    expect(LOCALE_COOKIE.path).toBe('/');
  });

  it('maps every supported locale to a direction', () => {
    expect(
      SUPPORTED_LOCALES.map((locale) => LOCALE_META[locale].direction),
    ).toEqual(['rtl', 'ltr']);
  });
});

describe('localizedPath', () => {
  it.each([
    ['ar', '/', '/ar'],
    ['en', '/', '/en'],
    ['ar', '/organizations', '/ar/organizations'],
    ['en', '/organizations', '/en/organizations'],
    ['en', '/organizations/abc/members', '/en/organizations/abc/members'],
  ] as const)('%s + %s → %s', (locale, href, expected) => {
    expect(localizedPath(locale, href)).toBe(expected);
  });

  it('does not leave a trailing slash on the dashboard', () => {
    // `/en/` and `/en` are different URLs to the router; emitting the first
    // would cost a redirect on the most-visited route in the application.
    expect(localizedPath('en', '/')).toBe('/en');
  });

  it('carries no mount point of its own', () => {
    // `basename` applies `/platform`; baking it in here would double it up.
    expect(localizedPath('en', '/organizations')).not.toContain(
      PLATFORM_BASE_PATH,
    );
  });

  it('round-trips through stripLocalePrefix for every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const path of ['/', '/organizations', '/organizations/a/members']) {
        expect(stripLocalePrefix(localizedPath(locale, path))).toBe(path);
      }
    }
  });
});

describe('stripLocalePrefix', () => {
  it.each([
    ['/en', '/'],
    ['/ar', '/'],
    ['/en/organizations', '/organizations'],
    ['/ar/organizations/abc', '/organizations/abc'],
    // Not a locale segment, so nothing is removed.
    ['/organizations', '/organizations'],
    ['/', '/'],
  ])('%s → %s', (input, expected) => {
    expect(stripLocalePrefix(input)).toBe(expected);
  });

  it('does not strip a path that merely starts with the letters', () => {
    expect(stripLocalePrefix('/entries')).toBe('/entries');
    expect(stripLocalePrefix('/archive')).toBe('/archive');
  });
});

describe('localeFromPathname', () => {
  it.each([
    ['/en/organizations', 'en'],
    ['/ar', 'ar'],
  ])('%s → %s', (input, expected) => {
    expect(localeFromPathname(input)).toBe(expected);
  });

  it.each(['/organizations', '/fr/organizations', '/', ''])(
    'reports %s as having no locale',
    (input) => {
      expect(localeFromPathname(input)).toBeUndefined();
    },
  );
});

describe('stripBasePath', () => {
  it('removes the mount point', () => {
    expect(stripBasePath('/platform/en/organizations')).toBe(
      '/en/organizations',
    );
  });

  it('turns the bare mount point into a root path', () => {
    expect(stripBasePath('/platform')).toBe('/');
  });

  it('leaves a path that has already lost it alone', () => {
    // Router locations arrive without it; `window.location` arrives with it.
    expect(stripBasePath('/en/organizations')).toBe('/en/organizations');
  });

  it('does not strip a lookalike segment', () => {
    expect(stripBasePath('/platformer/en')).toBe('/platformer/en');
  });
});

describe('localeFallbackPath', () => {
  it('adds the default locale to a link that omitted one', () => {
    expect(localeFallbackPath('/platform/organizations')).toBe(
      `/${DEFAULT_LOCALE}/organizations`,
    );
  });

  it('is deterministic rather than negotiated', () => {
    // No `accept-language`, no cookie, no previous visit: the same URL means
    // the same thing to everyone who opens it.
    expect(localeFallbackPath('/platform/')).toBe(
      localeFallbackPath('/platform/'),
    );
    expect(localeFallbackPath('/platform')).toBe(`/${DEFAULT_LOCALE}`);
  });

  it('prefixes rather than rewrites an unsupported locale', () => {
    // `/fr/x` becomes `/ar/fr/x`, which matches no route and 404s. Silently
    // serving Arabic for a French URL would claim we speak French.
    expect(localeFallbackPath('/platform/fr/organizations')).toBe(
      `/${DEFAULT_LOCALE}/fr/organizations`,
    );
  });

  it('always produces a path the locale route can match', () => {
    for (const input of ['/platform', '/platform/organizations', '/platform/x/y']) {
      expect(localeFromPathname(localeFallbackPath(input))).toBe(DEFAULT_LOCALE);
    }
  });
});
