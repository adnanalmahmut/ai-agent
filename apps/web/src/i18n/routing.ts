import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@repo/i18n-core';
import { defineRouting } from 'next-intl/routing';

import { webI18nConfig } from './config';

/**
 * The one routing definition for the app.
 *
 * Locale list and default come from `@repo/i18n-core` so that web and backend
 * can never drift apart; URL shape and detection policy come from
 * `./config`. Nothing else in the app should declare locales.
 */
export const routing = defineRouting({
  locales: SUPPORTED_LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: webI18nConfig.localePrefixMode,
  localeDetection: webI18nConfig.localeDetection,
  localeCookie: webI18nConfig.localeCookie,
  alternateLinks: webI18nConfig.alternateLinks,
});
