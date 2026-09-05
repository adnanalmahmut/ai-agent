import { cn } from '@repo/ui';
import {
  BookText,
  FolderKanban,
  LayoutDashboard,
  Lightbulb,
  Mail,
  Settings,
  ShieldCheck,
  Users,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { useTranslations } from 'use-intl';

import { ORGANIZATION_ROUTES } from '@/features/auth/routes';
import { Link, usePathname } from '@/i18n/navigation';

type Tab = {
  href: string;
  label: string;
  Icon: ComponentType<{ className?: string }>;
  exact: boolean;
};

export function OrganizationTabs({
  organizationId,
}: {
  organizationId: string;
}) {
  const t = useTranslations('Organization');
  const pathname = usePathname();

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
      href: ORGANIZATION_ROUTES.knowledge(organizationId),
      label: t('tabs.knowledge'),
      Icon: BookText,
      exact: false,
    },
    {
      href: ORGANIZATION_ROUTES.contentIdeas(organizationId),
      label: t('tabs.contentIdeas'),
      Icon: Lightbulb,
      exact: false,
    },
    {
      href: ORGANIZATION_ROUTES.contentProjects(organizationId),
      label: t('tabs.contentProjects'),
      Icon: FolderKanban,
      exact: false,
    },
    {
      href: ORGANIZATION_ROUTES.approvals(organizationId),
      label: t('tabs.approvals'),
      Icon: ShieldCheck,
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
    <nav aria-label={t('tabs.label')} className="overflow-x-auto py-1">
      <div className="inline-flex items-center gap-1 rounded-lg bg-secondary/70 p-1 border border-border/40 shadow-2xs">
        {tabs.map(({ href, label, Icon, exact }) => {
          const isActive = exact
            ? pathname === href
            : pathname === href || pathname.startsWith(`${href}/`);

          return (
            <Link
              key={href}
              href={href}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-all outline-none',
                'focus-visible:ring-1 focus-visible:ring-ring',
                isActive
                  ? 'bg-background text-foreground shadow-2xs border border-border/60'
                  : 'text-muted-foreground hover:text-foreground hover:bg-background/40',
              )}
            >
              <Icon
                className={cn(
                  'size-3.5',
                  isActive ? 'text-primary' : 'text-muted-foreground',
                )}
                aria-hidden
              />
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
