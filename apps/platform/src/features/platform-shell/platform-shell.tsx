import { Button, SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from '@repo/ui';
import { ShieldAlert } from 'lucide-react';
import { Outlet } from 'react-router';
import { useTranslations } from 'use-intl';

import { LanguageSwitcher } from '@/components/language-switcher';
import { ModeToggle } from '@/components/mode-toggle';
import { authClient } from '@/features/auth/auth-client';
import { usePlatformSession } from '@/features/auth/use-platform-session';
import { ActiveOrganization } from '@/features/organization/components/active-organization';

import { PlatformSidebar } from './platform-sidebar';

function MobileSidebarTrigger() {
  const t = useTranslations('Platform');
  const { isMobile } = useSidebar();

  if (!isMobile) return null;

  return (
    <SidebarTrigger
      label={t('nav.toggle')}
      className="me-1 size-8 text-muted-foreground hover:text-foreground"
    />
  );
}

/**
 * The frame every authenticated page renders inside.
 */
export function PlatformShell() {
  const t = useTranslations('Platform');
  const session = usePlatformSession();
  const isImpersonating = Boolean(session.session.impersonatedBy);

  return (
    <SidebarProvider className="bg-page-background min-h-screen">
      <PlatformSidebar />

      <SidebarInset className="border border-border/60 bg-background overflow-hidden shadow-xs rounded-xl md:rounded-2xl">
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border/50 bg-background/95 px-4 backdrop-blur md:px-6">
          <MobileSidebarTrigger />

          <div className="min-w-0 flex-1">
            <ActiveOrganization />
          </div>

          <nav aria-label={t('nav.accountLabel')} className="flex items-center gap-2">
            <LanguageSwitcher />
            <ModeToggle />
          </nav>
        </header>

        {isImpersonating ? (
          <div className="flex flex-wrap items-center justify-between gap-2 bg-amber-500/10 text-amber-900 dark:text-amber-200 border-b border-amber-500/30 px-4 py-2 text-xs font-semibold">
            <div className="flex items-center gap-2">
              <ShieldAlert className="size-4 shrink-0 text-amber-500" />
              <span>
                {t('impersonating.banner', {
                  name: session.user.name ?? session.user.email,
                  email: session.user.email,
                })}
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-xs border-amber-500/40 hover:bg-amber-500/20"
              onClick={() => {
                void authClient.admin.stopImpersonating({
                  fetchOptions: {
                    onSuccess: () => {
                      window.location.reload();
                    },
                  },
                });
              }}
            >
              {t('impersonating.stop')}
            </Button>
          </div>
        ) : null}

        <main className="flex-1 px-4 py-6 md:px-6 md:py-8">
          <div className="mx-auto w-full max-w-6xl">
            <Outlet />
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
