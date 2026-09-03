import { hasLocale } from 'next-intl';
import { notFound } from 'next/navigation';
import * as rootParams from 'next/root-params';
import { getRequestConfig } from 'next-intl/server';

import { routing } from './routing';

export default getRequestConfig(async () => {
  const segment = await rootParams.locale();
  if (!hasLocale(routing.locales, segment)) notFound();

  return {
    locale: segment,
    messages: (await import(`../../messages/${segment}.json`)).default,
  };
});
