/**
 * Single source of truth for the locales supported across the whole monorepo.
 *
 * This module deliberately contains *only* locale identity data:
 *   - which locales exist
 *   - which one is the default
 *   - the reading direction of each
 *
 * It must never contain translation strings, date/number format patterns, or
 * framework configuration (next-intl / NestJS). Those belong to the consuming
 * application, because web and backend have different responsibilities.
 */

export const SUPPORTED_LOCALES = ['ar', 'en'] as const;

export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

export type AppDirection = 'rtl' | 'ltr';

export const DEFAULT_LOCALE: AppLocale = 'ar';

export type LocaleMeta = {
  code: AppLocale;
  name: string;
  nativeName: string;
  direction: AppDirection;
};

export const LOCALE_META = {
  ar: {
    code: 'ar',
    name: 'Arabic',
    nativeName: 'العربية',
    direction: 'rtl',
  },
  en: {
    code: 'en',
    name: 'English',
    nativeName: 'English',
    direction: 'ltr',
  },
} satisfies Record<AppLocale, LocaleMeta>;

/**
 * Type guard used at every boundary where an untrusted value claims to be a
 * locale (URL segment, HTTP header, cookie, queue payload).
 */
export function isAppLocale(value: unknown): value is AppLocale {
  return (
    typeof value === 'string' &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

/**
 * Lenient parse for values coming from the outside world (headers, cookies,
 * persisted user preferences). Returns `undefined` instead of a fallback so
 * callers can continue their own resolution chain rather than being forced
 * into the default locale prematurely.
 */
export function parseAppLocale(value: unknown): AppLocale | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return isAppLocale(normalized) ? normalized : undefined;
}

/**
 * Strict resolve: always yields a usable locale. Use at the point where a
 * decision can no longer be deferred (rendering, enqueueing a job).
 */
export function resolveAppLocale(value: unknown): AppLocale {
  return parseAppLocale(value) ?? DEFAULT_LOCALE;
}

export function getDirection(locale: AppLocale): AppDirection {
  return LOCALE_META[locale].direction;
}
