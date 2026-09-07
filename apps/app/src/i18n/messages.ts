import { DEFAULT_LOCALE, type AppLocale } from '@repo/i18n-core';

import arabic from '../../messages/ar.json';
import type english from '../../messages/en.json';

export type AppMessages = typeof english;

export const defaultMessages: AppMessages = arabic;

const DICTIONARIES: Record<AppLocale, () => Promise<AppMessages>> = {
  ar: () => Promise.resolve(arabic),
  en: () => import('../../messages/en.json').then((module) => module.default),
};

export const STATIC_DICTIONARY_LOCALE: AppLocale = 'ar';
export const DEFAULT_LOCALES_MATCH =
  STATIC_DICTIONARY_LOCALE === DEFAULT_LOCALE;

const cache = new Map<AppLocale, AppMessages>([
  [STATIC_DICTIONARY_LOCALE, arabic],
]);

export async function loadMessages(locale: AppLocale): Promise<AppMessages> {
  const cached = cache.get(locale);
  if (cached) return cached;

  const messages = await DICTIONARIES[locale]();
  cache.set(locale, messages);

  return messages;
}
