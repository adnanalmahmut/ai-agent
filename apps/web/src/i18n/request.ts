import { hasLocale } from 'next-intl';
import { getRequestConfig } from 'next-intl/server';
import * as rootParams from 'next/root-params';
import { notFound } from 'next/navigation';

import { routing } from './routing';

/**
 * Per-request i18n configuration.
 *
 * Next.js 16 exposes the root `[locale]` segment through `next/root-params`,
 * which is what next-intl 4.13 documents in place of the now-deprecated
 * `requestLocale` / `setRequestLocale` pair. Static rendering works without
 * any extra call per layout or page.
 *
 * The locale is validated *before* it is interpolated into a module path — an
 * unvalidated segment value must never reach the dynamic `import()`, because
 * `[locale]` effectively acts as a catch-all for unknown routes.
 */
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
