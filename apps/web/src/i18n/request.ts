import { hasLocale } from 'next-intl';
import { getRequestConfig } from 'next-intl/server';
import * as rootParams from 'next/root-params';
import { notFound } from 'next/navigation';

import { routing } from './routing';

export default getRequestConfig(async () => {
  const segment = await rootParams.locale();

  if (!hasLocale(routing.locales, segment)) {
    notFound();
  }

  const locale = segment;

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
