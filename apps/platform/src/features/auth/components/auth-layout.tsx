import type { ReactNode } from 'react';

import { BrandMark } from '@/components/brand-mark';
import { LanguageSwitcher } from '@/components/language-switcher';
import { ModeToggle } from '@/components/mode-toggle';
import { publicConfig } from '@/config/public';

/**
 * The frame around every public authentication page.
 *
 * Strictly outside the dashboard: no sidebar, no organization navigation, no
 * account menu. A sign-in form surrounded by the navigation of an application
 * you are not signed in to is a contradiction the reader can see, and every
 * link in it would lead somewhere they would be bounced away from.
 *
 * It performs no authentication check of its own. Bouncing an already
 * signed-in user belongs on `/sign-in` and `/sign-up` specifically — the other
 * pages under this layout are reachable *with* a session and would be broken
 * by a blanket guard, because a signed-in user may still need to confirm their
 * address or follow a reset link from their mailbox.
 *
 * Language and theme controls are present for the same reason they are in the
 * shell: someone who cannot sign in yet still needs to be able to read the
 * page.
 */
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
        <div className="w-full max-w-md">
          {children}
        </div>
      </main>
    </div>
  );
}
