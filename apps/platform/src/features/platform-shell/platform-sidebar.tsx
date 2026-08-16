import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarSeparator,
} from '@repo/ui';
import {
  Building2,
  LayoutDashboard,
  Mail,
  Palette,
  Settings,
  Users,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { useTranslations } from 'use-intl';

import { BrandMark } from '@/components/brand-mark';
import { publicConfig } from '@/config/public';
import {
  ORGANIZATION_ROUTES,
  PLATFORM_ROUTES,
} from '@/features/auth/routes';
import { OrganizationSwitcher } from '@/features/organization/components/organization-switcher';
import { Link, useAppLocation } from '@/i18n/navigation';

import { useCurrentOrganization } from './use-current-organization';

type NavItem = {
  href: string;
  label: string;
  Icon: ComponentType<{ className?: string }>;
  exact: boolean;
};

/**
 * The platform's primary navigation.
 *
 * Two groups, and the second one is conditional. The organization sections
 * only appear once there *is* an organization in context — a reader who
 * belongs to none would otherwise be shown four links that all lead to a page
 * explaining that they belong to none.
 *
 * Every entry is a link, and the current one carries `aria-current="page"` as
 * well as the design system's active styling, so the position is available to
 * a screen reader and not only to the eye.
 *
 * Direction is not handled here at all, and that is deliberate: the sidebar
 * primitive is written in logical properties, so `side="left"` already means
 * the reading-start edge and the whole panel mirrors in Arabic with no
 * condition anywhere in this file.
 */
export function PlatformSidebar() {
  const t = useTranslations('Platform');
  const { pathname } = useAppLocation();
  const current = useCurrentOrganization();

  const primary: NavItem[] = [
    {
      href: PLATFORM_ROUTES.dashboard,
      label: t('nav.dashboard'),
      Icon: LayoutDashboard,
      exact: true,
    },
    {
      href: PLATFORM_ROUTES.organizations,
      label: t('nav.organizations'),
      Icon: Building2,
      exact: false,
    },
    {
      href: PLATFORM_ROUTES.designSystem,
      label: t('nav.designSystem'),
      Icon: Palette,
      exact: false,
    },
  ];

  const organizationSections: NavItem[] = current
    ? [
        {
          href: ORGANIZATION_ROUTES.overview(current.id),
          label: t('nav.overview'),
          Icon: LayoutDashboard,
          exact: true,
        },
        {
          href: ORGANIZATION_ROUTES.members(current.id),
          label: t('nav.members'),
          Icon: Users,
          exact: false,
        },
        {
          href: ORGANIZATION_ROUTES.invitations(current.id),
          label: t('nav.invitations'),
          Icon: Mail,
          exact: false,
        },
        {
          href: ORGANIZATION_ROUTES.settings(current.id),
          label: t('nav.settings'),
          Icon: Settings,
          exact: false,
        },
      ]
    : [];

  const isCurrent = (item: NavItem) =>
    item.exact
      ? pathname === item.href
      : pathname === item.href || pathname.startsWith(`${item.href}/`);

  return (
    <Sidebar
      collapsible="offcanvas"
      mobileTitle={t('nav.label')}
      mobileDescription={t('nav.mobileDescription')}
    >
      <SidebarHeader className="gap-3">
        <Link
          href={PLATFORM_ROUTES.dashboard}
          className="flex items-center gap-3 rounded-md px-1 py-1 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <BrandMark />
          <span className="truncate text-sm font-semibold">
            {publicConfig.appName}
          </span>
        </Link>

        <OrganizationSwitcher />
      </SidebarHeader>

      <SidebarSeparator />

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>{t('nav.platformGroup')}</SidebarGroupLabel>

          <SidebarGroupContent>
            <SidebarMenu>
              {primary.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    asChild
                    isActive={isCurrent(item)}
                    tooltip={item.label}
                  >
                    <Link
                      href={item.href}
                      aria-current={isCurrent(item) ? 'page' : undefined}
                    >
                      <item.Icon />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {current ? (
          <SidebarGroup>
            <SidebarGroupLabel>
              <span className="truncate">{current.name}</span>
            </SidebarGroupLabel>

            <SidebarGroupContent>
              <SidebarMenuSub>
                {organizationSections.map((item) => (
                  <SidebarMenuSubItem key={item.href}>
                    <SidebarMenuSubButton
                      asChild
                      isActive={isCurrent(item)}
                    >
                      <Link
                        href={item.href}
                        aria-current={isCurrent(item) ? 'page' : undefined}
                      >
                        <item.Icon />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                ))}
              </SidebarMenuSub>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}
      </SidebarContent>

      <SidebarFooter />
    </Sidebar>
  );
}
