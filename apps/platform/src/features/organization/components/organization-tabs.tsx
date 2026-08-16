import { cn } from '@repo/ui';
import { LayoutDashboard, Mail, Settings, Users } from 'lucide-react';
import type { ComponentType } from 'react';
import { useTranslations } from 'use-intl';

import { ORGANIZATION_ROUTES } from '@/features/auth/routes';
import { Link, useAppLocation } from '@/i18n/navigation';

type Tab = {
  href: string;
  label: string;
  Icon: ComponentType<{ className?: string }>;
  /** Overview matches its path exactly; the rest also match their children. */
  exact: boolean;
};

/**
 * Navigation between the four faces of one organization.
 *
 * Real links rather than a tab widget, because these are four URLs: each is
 * bookmarkable, openable in a new tab and reachable with the Back button, none
 * of which a `role="tablist"` would give. So the markup is a `<nav>` of links
 * and the active one is marked with `aria-current`, which is what a screen
 * reader announces as "current page".
 *
 * The row scrolls rather than wraps on a narrow screen — four Arabic labels do
 * not fit across 390px, and a wrapped second line would push the content of
 * every organization page down.
 *
 * All four icons are direction-neutral, so none is mirrored.
 */
export function OrganizationTabs({
  organizationId,
}: {
  organizationId: string;
}) {
  const t = useTranslations('Organization');
  const { pathname } = useAppLocation();

  const tabs: Tab[] = [
    {
      href: ORGANIZATION_ROUTES.overview(organizationId),
      label: t('tabs.overview'),
      Icon: LayoutDashboard,
      exact: true,
    },
    {
      href: ORGANIZATION_ROUTES.members(organizationId),
      label: t('tabs.members'),
      Icon: Users,
      exact: false,
    },
    {
      href: ORGANIZATION_ROUTES.invitations(organizationId),
      label: t('tabs.invitations'),
      Icon: Mail,
      exact: false,
    },
    {
      href: ORGANIZATION_ROUTES.settings(organizationId),
      label: t('tabs.settings'),
      Icon: Settings,
      exact: false,
    },
  ];

  return (
    <nav aria-label={t('tabs.label')} className="overflow-x-auto">
      <ul className="flex min-w-max items-center gap-1 border-b">
        {tabs.map(({ href, label, Icon, exact }) => {
          const isActive = exact
            ? pathname === href
            : pathname === href || pathname.startsWith(`${href}/`);

          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm whitespace-nowrap outline-none',
                  'focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  isActive
                    ? 'border-primary font-medium text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="size-4" aria-hidden />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
