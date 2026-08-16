import { LOCALE_META, type AppLocale } from '@repo/i18n-core';
import { DirectionProvider } from '@repo/ui';
import { useEffect } from 'react';
import { Outlet, useLoaderData, type LoaderFunctionArgs } from 'react-router';
import { IntlProvider } from 'use-intl';

import { requireLocale } from '@/features/auth/loaders';
import { loadMessages, type AppMessages } from '@/i18n/messages';

export type LocaleRouteData = {
  locale: AppLocale;
  messages: AppMessages;
};

/**
 * The root of the localized tree.
 *
 * Its loader does two things that everything below depends on: it validates
 * the `:locale` segment (redirecting anything that is not a supported locale)
 * and it fetches that locale's dictionary. Both finish before a single child
 * renders, which is why no screen in this application ever paints an
 * untranslated key path and then swaps it out.
 */
export async function localeLoader({
  params,
  request,
}: LoaderFunctionArgs): Promise<LocaleRouteData> {
  const locale = requireLocale(params, new URL(request.url).pathname);

  return { locale, messages: await loadMessages(locale) };
}

export function LocaleRoute() {
  const { locale, messages } = useLoaderData<LocaleRouteData>();
  const { direction } = LOCALE_META[locale];

  // The document element is outside React's tree, so it is written to rather
  // than rendered. `dir` here is what makes every logical CSS property in the
  // application resolve correctly, and `lang` is what makes a screen reader
  // pronounce the page — both have to change when the reader switches
  // language, which is a client-side navigation with no document reload.
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = direction;
  }, [direction, locale]);

  return (
    <IntlProvider locale={locale} messages={messages}>
      {/*
        Radix portals (Dialog, DropdownMenu, Select, Sheet, …) mount outside
        this subtree in the DOM, so they cannot read `<html dir>`. The provider
        carries direction to them through React context instead.
      */}
      <DirectionProvider direction={direction}>
        <Outlet />
      </DirectionProvider>
    </IntlProvider>
  );
}
