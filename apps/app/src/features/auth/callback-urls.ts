import type { AppLocale } from '@repo/i18n-core';

import { PLATFORM_BASE_PATH } from '@/config/paths';
import { localizedPath } from '@/i18n/routing';

import { AUTH_ROUTES } from './routes';

export const VERIFICATION_STATUS_PARAM = 'status';
export const VERIFICATION_STATUS_VERIFIED = 'verified';

export const CALLBACK_ERROR_PARAM = 'error';

export function absoluteAppUrl(
  href: string,
  locale: AppLocale,
  origin: string,
): string {
  const [path, query] = splitQuery(href);
  const pathname = `${PLATFORM_BASE_PATH}${localizedPath(locale, path)}`;

  return new URL(`${pathname}${query}`, origin).toString();
}

export function verificationCallbackUrl(locale: AppLocale, origin: string) {
  return absoluteAppUrl(
    `${AUTH_ROUTES.verifyEmail}?${VERIFICATION_STATUS_PARAM}=${VERIFICATION_STATUS_VERIFIED}`,
    locale,
    origin,
  );
}

export function passwordResetCallbackUrl(locale: AppLocale, origin: string) {
  return absoluteAppUrl(AUTH_ROUTES.resetPassword, locale, origin);
}

function splitQuery(href: string): [string, string] {
  const index = href.indexOf('?');

  return index === -1 ? [href, ''] : [href.slice(0, index), href.slice(index)];
}
