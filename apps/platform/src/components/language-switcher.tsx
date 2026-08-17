import {
  LOCALE_META,
  SUPPORTED_LOCALES,
  type AppLocale,
} from '@repo/i18n-core';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@repo/ui';
import { Languages } from 'lucide-react';
import { useLocale, useTranslations } from 'use-intl';

import { rememberLocale } from '@/i18n/locale-cookie';
import { localeSwitchHref } from '@/i18n/locale-switch-href';
import { useAppLocation, useAppNavigate } from '@/i18n/navigation';

export function LanguageSwitcher() {
  const t = useTranslations('Navigation');
  const navigate = useAppNavigate();
  const location = useAppLocation();
  const activeLocale = useLocale() as AppLocale;

  function switchTo(nextLocale: AppLocale) {
    if (nextLocale === activeLocale) return;

    // Persisted for the backend, not for routing: it is how an emailed link
    // arrives in the language this reader chose. The URL still decides what
    // the platform renders.
    rememberLocale(nextLocale);

    // `useAppLocation` gives the path without the locale, and `navigate`
    // re-applies one — so the reader lands on the same page in the other
    // language, keeping their tab, filter or anchor.
    navigate(localeSwitchHref(location.pathname, location), {
      replace: true,
      locale: nextLocale,
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label={t('changeLanguage')}>
          <Languages className="size-[1.2rem] text-secondary-foreground" />
          <span className="sr-only">{t('changeLanguage')}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {SUPPORTED_LOCALES.map((locale) => (
          <DropdownMenuItem
            key={locale}
            onClick={() => switchTo(locale)}
            disabled={locale === activeLocale}
          >
            {/* Each language is named in its own language, never translated. */}
            <span lang={locale}>{LOCALE_META[locale].nativeName}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
