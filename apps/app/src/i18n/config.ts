export const LOCALE_PREFIX = 'always' as const;

export const LOCALE_DETECTION = false;

export const LOCALE_COOKIE = {
  name: 'APP_LOCALE',
  path: '/',
  sameSite: 'Lax',
  maxAgeSeconds: 60 * 60 * 24 * 365,
} as const;
