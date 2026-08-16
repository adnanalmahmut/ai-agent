import { ThemeProvider } from '@/components/theme-provider';
import { thmanyahSans, thmanyahSerifDisplay } from '@/config/fonts';
import { routing } from '@/i18n/routing';
import { DEFAULT_LOCALE, LOCALE_META, isAppLocale } from '@repo/i18n-core';
import { DirectionProvider } from '@repo/ui';
import '@repo/ui/globals.css';
import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';

type Props = {
  children: React.ReactNode;
};

export const metadata: Metadata = {
  title: 'Design System Showcase',
  description: 'Full-stack internationalized design system showcase',
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({ children }: Props) {
  // Already validated in `i18n/request.ts`, which calls `notFound()` for an
  // unsupported segment. The guard here narrows `string` to `AppLocale` so the
  // direction lookup below is exhaustive rather than defensive-by-cast.
  const requestLocale = await getLocale();
  const locale = isAppLocale(requestLocale) ? requestLocale : DEFAULT_LOCALE;

  const { direction } = LOCALE_META[locale];

  // Only the namespaces Client Components actually need cross the
  // server/client boundary. Server Components translate on the server through
  // `getTranslations`, so the rest of the dictionary never reaches the browser.
  const messages = await getMessages();
  const clientMessages = {
    Navigation: messages.Navigation,
    Theme: messages.Theme,
  };

  return (
    <html lang={locale} dir={direction} suppressHydrationWarning>
      <body
        className={`${thmanyahSans.variable} ${thmanyahSerifDisplay.variable} antialiased`}
      >
        <NextIntlClientProvider messages={clientMessages}>
          {/*
            Radix portals (Dialog, DropdownMenu, …) mount outside this subtree
            in the DOM, so they cannot read `<html dir>`. The provider carries
            direction to them through React context instead.
          */}
          <DirectionProvider direction={direction}>
            <ThemeProvider
              attribute="class"
              defaultTheme="system"
              enableSystem
              disableTransitionOnChange
            >
              {children}
            </ThemeProvider>
          </DirectionProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
