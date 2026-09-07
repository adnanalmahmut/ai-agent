'use client';

import {
  LOCALE_META,
  SUPPORTED_LOCALES,
  type AppLocale,
} from '@repo/i18n-core';
import { Button } from '@repo/ui';
import { useLocale, useTranslations } from 'use-intl';

import { usePathname, useRouter } from '@/i18n/navigation';

/**
 * Two languages, two buttons. `usePathname` gives the path without the
 * locale and the router re-applies one, so the reader stays on the page they
 * were on.
 */
export function LanguageSwitcher() {
  const t = useTranslations('language');
  const router = useRouter();
  const pathname = usePathname();
  const active = useLocale();

  return (
    <nav aria-label={t('label')} className="flex items-center gap-1">
      {SUPPORTED_LOCALES.map((locale: AppLocale) => (
        <Button
          key={locale}
          type="button"
          variant={locale === active ? 'secondary' : 'ghost'}
          size="sm"
          disabled={locale === active}
          onClick={() => router.replace(pathname, { locale })}
        >
          {/* Each language is named in its own language, never translated. */}
          <span lang={locale}>{LOCALE_META[locale].nativeName}</span>
        </Button>
      ))}
    </nav>
  );
}
