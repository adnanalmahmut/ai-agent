import type { AppLocale } from '@repo/i18n-core';
import { useLocale } from 'use-intl';

/**
 * The active locale, narrowed to the set this application is configured for.
 * Routing has already refused every other value by the time a client
 * component renders, so this states what the router established rather than
 * an assumption a caller has to defend.
 */
export function useAppLocale(): AppLocale {
  return useLocale() as AppLocale;
}
