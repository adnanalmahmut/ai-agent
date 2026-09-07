import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import { LanguageSwitcher } from '@/components/language-switcher';
import { SignOutButton } from '@/features/auth/sign-out-button';

/**
 * The frame every administrative screen will eventually render inside.
 *
 * There is no navigation, because there is nothing to navigate to: the
 * account and configuration screens still live in the customer application
 * and stay there until they are actually moved. A menu item pointing at a
 * screen that has not moved would be a claim about this surface that is not
 * true yet.
 */
export async function AdminShell({ children }: { children: ReactNode }) {
  const t = await getTranslations('shell');

  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex items-center justify-between gap-4 border-b px-6 py-4">
        <div>
          <p className="font-serif text-lg font-medium">{t('title')}</p>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <LanguageSwitcher />
          <SignOutButton label={t('signOut')} />
        </div>
      </header>
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
