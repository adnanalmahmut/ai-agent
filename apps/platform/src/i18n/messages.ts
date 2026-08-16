import { DEFAULT_LOCALE, type AppLocale } from '@repo/i18n-core';

import arabic from '../../messages/ar.json';
import type english from '../../messages/en.json';

/** The message tree, shaped by the English file as the reference. */
export type AppMessages = typeof english;

/**
 * The dictionary that is always in the bundle.
 *
 * The default locale's, and it is static rather than split for two reasons.
 * It is the one most readers get, so splitting it only buys them a second
 * round trip. And the error boundary needs *some* dictionary to render in —
 * including when the failure it is reporting is a chunk that would not load —
 * so a translated error page is only possible if one dictionary is
 * unconditionally present.
 *
 * `DEFAULT_LOCALES_MATCH` below asserts that this is the file it claims to be.
 */
export const defaultMessages: AppMessages = arabic;

/**
 * Every other locale, loaded on demand.
 *
 * The map is written out rather than globbed on purpose. Typing it as
 * `Record<AppLocale, …>` means adding a locale to `@repo/i18n-core` fails to
 * compile here until its file exists — which is the coupling we want, because
 * a glob would instead ship and 404 at runtime. Nothing else in the
 * application names a locale.
 */
const DICTIONARIES: Record<AppLocale, () => Promise<AppMessages>> = {
  ar: () => Promise.resolve(arabic),
  en: () => import('../../messages/en.json').then((module) => module.default),
};

/**
 * Guards the assumption above: the statically bundled dictionary is the
 * default locale's. Read by a test; a change to `DEFAULT_LOCALE` that is not
 * matched here fails it rather than quietly shipping the wrong fallback.
 */
export const STATIC_DICTIONARY_LOCALE: AppLocale = 'ar';
export const DEFAULT_LOCALES_MATCH =
  STATIC_DICTIONARY_LOCALE === DEFAULT_LOCALE;

const cache = new Map<AppLocale, AppMessages>([[STATIC_DICTIONARY_LOCALE, arabic]]);

/**
 * Reads a dictionary, once per locale per session.
 *
 * Called from the locale route's loader, so the messages are in hand before
 * the tree below renders and no screen ever paints untranslated.
 */
export async function loadMessages(locale: AppLocale): Promise<AppMessages> {
  const cached = cache.get(locale);
  if (cached) return cached;

  const messages = await DICTIONARIES[locale]();
  cache.set(locale, messages);

  return messages;
}
