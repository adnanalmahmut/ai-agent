import { LOCALE_META, isAppLocale } from '@repo/i18n-core';
import { DirectionProvider } from '@repo/ui';
import '@repo/ui/globals.css';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import type { ReactNode } from 'react';

import { thmanyahSans, thmanyahSerifDisplay } from '@/config/fonts';
import { publicConfig } from '@/config/public';
import { routing } from '@/i18n/routing';

export const metadata: Metadata = {
  title: `${publicConfig.appName} Admin`,
  description: 'Administrative workspace',
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isAppLocale(locale)) notFound();

  const messages = await getMessages();
  const { direction } = LOCALE_META[locale];

  return (
    <html lang={locale} dir={direction} suppressHydrationWarning>
      <body
        className={`${thmanyahSans.variable} ${thmanyahSerifDisplay.variable} antialiased`}
      >
        <NextIntlClientProvider messages={messages}>
          <DirectionProvider direction={direction}>{children}</DirectionProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
