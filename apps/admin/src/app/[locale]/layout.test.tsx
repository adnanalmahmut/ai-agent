import { LOCALE_META, SUPPORTED_LOCALES } from '@repo/i18n-core';
import { isValidElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import english from '../../../messages/en.json';

/**
 * Writing direction is decided once, here, from the locale in the URL — so an
 * Arabic screen is right-to-left before any component has rendered and
 * without any component having to know. The assertion is on the document
 * element the layout produces, which is where a browser actually reads it.
 */

vi.mock('@/config/fonts', () => ({
  thmanyahSans: { variable: '--font-sans' },
  thmanyahSerifDisplay: { variable: '--font-serif' },
}));
vi.mock('next-intl/server', () => ({
  getMessages: () => Promise.resolve(english),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

const { default: LocaleLayout, generateStaticParams } = await import('./layout');

async function documentElement(locale: string) {
  const output = await LocaleLayout({
    children: null,
    params: Promise.resolve({ locale }),
  });

  if (!isValidElement(output)) throw new Error('the layout rendered nothing');

  return output as ReturnType<typeof isValidElement> extends never
    ? never
    : { type: unknown; props: { lang?: string; dir?: string } };
}

describe('the document the workspace renders into', () => {
  it('marks Arabic as right to left', async () => {
    const html = await documentElement('ar');

    expect(html.type).toBe('html');
    expect(html.props.lang).toBe('ar');
    expect(html.props.dir).toBe('rtl');
  });

  it('marks English as left to right', async () => {
    const html = await documentElement('en');

    expect(html.props.lang).toBe('en');
    expect(html.props.dir).toBe('ltr');
  });

  it.each(SUPPORTED_LOCALES)(
    'takes the direction for %s from the shared locale metadata',
    async (locale) => {
      const html = await documentElement(locale);

      expect(html.props.dir).toBe(LOCALE_META[locale].direction);
    },
  );

  it('refuses a locale the applications do not support', async () => {
    await expect(documentElement('de')).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('offers both locales for prerendering', () => {
    expect(generateStaticParams()).toEqual([
      { locale: 'ar' },
      { locale: 'en' },
    ]);
  });
});
