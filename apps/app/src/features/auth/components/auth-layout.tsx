import type { ReactNode } from 'react';

import { BrandMark } from '@/components/brand-mark';
import { LanguageSwitcher } from '@/components/language-switcher';
import { ModeToggle } from '@/components/mode-toggle';
import { publicConfig } from '@/config/public';

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-muted/40">
      <header className="px-5 py-5 md:px-8">
        <div className="mx-auto flex max-w-md items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <BrandMark />
            <span className="text-sm font-semibold">
              {publicConfig.appName}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <LanguageSwitcher />
            <ModeToggle />
          </div>
        </div>
      </header>

      <main className="flex flex-1 items-start justify-center px-5 pb-16 md:items-center md:px-8 md:pb-24">
        <div className="w-full max-w-md">{children}</div>
      </main>
    </div>
  );
}
