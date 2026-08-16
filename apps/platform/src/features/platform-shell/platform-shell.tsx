import { Separator, SidebarInset, SidebarProvider, SidebarTrigger } from '@repo/ui';
import { Outlet } from 'react-router';
import { useTranslations } from 'use-intl';

import { LanguageSwitcher } from '@/components/language-switcher';
import { ModeToggle } from '@/components/mode-toggle';
import { usePlatformSession } from '@/features/auth/use-platform-session';
import { ActiveOrganization } from '@/features/organization/components/active-organization';

import { PlatformSidebar } from './platform-sidebar';
import { UserAccountMenu } from './user-account-menu';

/**
 * The frame every authenticated page renders inside.
 *
 * It renders only below the protected route's loader, so by the time any of
 * this exists the session has been confirmed by the backend. There is no
 * signed-out flash and no moment where navigation is shown to someone who
 * cannot use it — the sidebar simply never mounts for an anonymous visitor.
 *
 * Authentication pages deliberately do not come through here. They have their
 * own layout, because a sign-in form framed by the navigation of an
 * application you are not signed in to is a contradiction the reader can see.
 *
 * The sidebar primitive owns the responsive behaviour: a persistent panel from
 * `md` up, the project's Sheet as a drawer below it, a keyboard shortcut, and
 * a state cookie so a collapsed sidebar stays collapsed. None of that is
 * reimplemented here.
 */
export function PlatformShell() {
  const t = useTranslations('Platform');
  const session = usePlatformSession();

  return (
    <SidebarProvider>
      <PlatformSidebar />

      <SidebarInset>
        <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur md:px-6">
          {/*
            On desktop this collapses the panel; on mobile it opens the
            drawer. The label is passed rather than set with `aria-label` so
            the visually-hidden text and the accessible name are the same
            string — one of them being English would be a difference nobody
            sees until they use a screen reader.
          */}
          <SidebarTrigger label={t('nav.toggle')} className="-ms-1" />

          <Separator
            orientation="vertical"
            className="me-1 data-[orientation=vertical]:h-4"
          />

          <div className="min-w-0 flex-1">
            <ActiveOrganization />
          </div>

          <nav aria-label={t('nav.accountLabel')} className="flex items-center gap-2">
            <LanguageSwitcher />
            <ModeToggle />

            <UserAccountMenu
              name={session.user.name ?? null}
              email={session.user.email}
              image={session.user.image}
            />
          </nav>
        </header>

        <main className="flex-1 px-4 py-6 md:px-6 md:py-8">
          <div className="mx-auto w-full max-w-6xl">
            <Outlet />
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
