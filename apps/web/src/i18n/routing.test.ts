import { DEFAULT_LOCALE, LOCALE_META, SUPPORTED_LOCALES } from '@repo/i18n-core';
import { createNavigation } from 'next-intl/navigation';
import { defineRouting } from 'next-intl/routing';
import { describe, expect, it } from 'vitest';

import { webI18nConfig, type LocalePrefixMode } from './config';
import { routing } from './routing';

/**
 * Builds the navigation helpers for a given URL shape.
 *
 * The language switcher never branches on the prefix mode — it hands a
 * locale-agnostic pathname to next-intl and lets `routing` apply the prefix.
 * `getPathname` is that mechanism, so exercising it here is what proves the
 * switcher works under both modes without a browser.
 */
function navigationFor(mode: LocalePrefixMode) {
  return createNavigation(
    defineRouting({
      locales: SUPPORTED_LOCALES,
      defaultLocale: DEFAULT_LOCALE,
      localePrefix: mode,
      localeDetection: webI18nConfig.localeDetection,
      localeCookie: webI18nConfig.localeCookie,
    }),
  );
}

describe('routing policy', () => {
  it('takes its locales and default from the shared core', () => {
    expect(routing.locales).toEqual(SUPPORTED_LOCALES);
    expect(routing.defaultLocale).toBe(DEFAULT_LOCALE);
    expect(routing.defaultLocale).toBe('ar');
  });

  it('never lets the browser or a cookie choose the web locale', () => {
    // The project policy: the URL is the only source of truth. This must not
    // become environment-dependent or be flipped for convenience.
    expect(routing.localeDetection).toBe(false);
    expect(webI18nConfig.localeDetection).toBe(false);
  });

  it('keeps the locale cookie as a preference, not a routing input', () => {
    expect(webI18nConfig.localeCookie.name).toBe('APP_LOCALE');
  });

  it('introduces no SEO surface via alternate links', () => {
    expect(webI18nConfig.alternateLinks).toBe(false);
  });

  it('maps every supported locale to a direction', () => {
    expect(SUPPORTED_LOCALES.map((locale) => LOCALE_META[locale].direction))
      .toEqual(['rtl', 'ltr']);
  });
});

describe('locale-aware pathnames', () => {
  describe('always', () => {
    const { getPathname } = navigationFor('always');

    it.each([
      ['ar', '/', '/ar'],
      ['en', '/', '/en'],
      ['ar', '/settings', '/ar/settings'],
      ['en', '/settings', '/en/settings'],
      ['ar', '/dashboard/reports', '/ar/dashboard/reports'],
      ['en', '/dashboard/reports', '/en/dashboard/reports'],
    ])('%s + %s → %s', (locale, href, expected) => {
      expect(getPathname({ locale: locale as 'ar' | 'en', href })).toBe(
        expected,
      );
    });
  });

  describe('as-needed', () => {
    const { getPathname } = navigationFor('as-needed');

    it.each([
      // The default locale is unprefixed; every other locale keeps its prefix.
      ['ar', '/', '/'],
      ['en', '/', '/en'],
      ['ar', '/settings', '/settings'],
      ['en', '/settings', '/en/settings'],
      ['ar', '/dashboard/reports', '/dashboard/reports'],
      ['en', '/dashboard/reports', '/en/dashboard/reports'],
    ])('%s + %s → %s', (locale, href, expected) => {
      expect(getPathname({ locale: locale as 'ar' | 'en', href })).toBe(
        expected,
      );
    });
  });

  it('round-trips a switch back to the original path in both modes', () => {
    for (const mode of ['always', 'as-needed'] as const) {
      const { getPathname } = navigationFor(mode);

      const arabic = getPathname({ locale: 'ar', href: '/settings' });
      const english = getPathname({ locale: 'en', href: '/settings' });

      expect(arabic).not.toBe(english);
      // Switching language must land on the same page, never the home page.
      expect(arabic.endsWith('/settings')).toBe(true);
      expect(english.endsWith('/settings')).toBe(true);
    }
  });
});
