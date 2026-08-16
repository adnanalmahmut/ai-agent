'use client';

import { localeSwitchHref } from '@/i18n/locale-switch-href';
import { usePathname, useRouter } from '@/i18n/navigation';
import { LOCALE_META, SUPPORTED_LOCALES, type AppLocale } from '@repo/i18n-core';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@repo/ui';
import { Languages } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

export function LanguageSwitcher() {
  const t = useTranslations('Navigation');
  const router = useRouter();
  const activeLocale = useLocale() as AppLocale;

  // `usePathname` from `@/i18n/navigation` returns the pathname *without* the
  // locale prefix, and `router.replace` re-applies whichever prefix the
  // configured mode calls for. That is what makes this component work
  // unchanged under both `always` and `as-needed` — no conditional here.
  const pathname = usePathname();

  function switchTo(nextLocale: AppLocale) {
    if (nextLocale === activeLocale) return;

    // Read the query string and fragment at click time rather than through
    // `useSearchParams`, which would opt the whole page out of static
    // rendering for values only ever needed inside this handler.
    const target = localeSwitchHref(
      pathname,
      typeof window === 'undefined' ? undefined : window.location,
    );

    router.replace(target, { locale: nextLocale });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label={t('changeLanguage')}>
          <Languages className="size-[1.2rem]" />
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
