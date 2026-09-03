import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@repo/i18n-core';
import { defineRouting } from 'next-intl/routing';

import { webI18nConfig } from './config';

export const routing = defineRouting({
  locales: SUPPORTED_LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: webI18nConfig.localePrefixMode,
  localeDetection: webI18nConfig.localeDetection,
  localeCookie: webI18nConfig.localeCookie,
  alternateLinks: webI18nConfig.alternateLinks,
});
