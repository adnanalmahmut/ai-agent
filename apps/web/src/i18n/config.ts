export type LocalePrefixMode = 'always' | 'as-needed';

export const webI18nConfig = {
  localePrefixMode: 'as-needed' as LocalePrefixMode,

  localeDetection: false,

  localeCookie: {
    name: 'APP_LOCALE',
    path: '/',
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 365,
  },

  alternateLinks: false,
} as const;
