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
  SidebarTrigger,
} from '@repo/ui';
import {
  Building2,
  Command,
  LayoutDashboard,
  Mail,
  Palette,
  Search,
  Settings,
  Shield,
  UserCog,
  Users,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { useTranslations } from 'use-intl';

import { BrandMark } from '@/components/brand-mark';
import { publicConfig } from '@/config/public';
import { ORGANIZATION_ROUTES, PLATFORM_ROUTES } from '@/features/auth/routes';
import { useGlobalPermission } from '@/features/authorization/use-permissions';
import { OrganizationSwitcher } from '@/features/organization/components/organization-switcher';
import { UserAccountMenu } from '@/features/platform-shell/user-account-menu';
import { Link, useAppLocation } from '@/i18n/navigation';

import { useCurrentOrganization } from './use-current-organization';

type NavItem = {
  href: string;
  label: string;
  Icon: ComponentType<{ className?: string }>;
  exact: boolean;
  badge?: string;
  shortcut?: string;
};

/**
 * The platform's primary navigation drawer with collapsible icon-only mode and centered icons.
 */
export function PlatformSidebar() {
  const t = useTranslations('Platform');
  const { pathname } = useAppLocation();
  const current = useCurrentOrganization();
  const canManageUsers = useGlobalPermission({ user: ['list'] });

  const primary: NavItem[] = [
    {
      href: PLATFORM_ROUTES.dashboard,
      label: t('nav.dashboard'),
      Icon: LayoutDashboard,
      exact: true,
      shortcut: '⌘1',
    },
    {
      href: PLATFORM_ROUTES.organizations,
      label: t('nav.organizations'),
      Icon: Building2,
      exact: false,
      shortcut: '⌘2',
    },
    {
      href: PLATFORM_ROUTES.userSettings,
      label: t('nav.userSettings'),
      Icon: UserCog,
      exact: false,
    },
    ...(canManageUsers
      ? [
          {
            href: PLATFORM_ROUTES.adminUsers,
            label: t('nav.adminUsers'),
            Icon: Shield,
            exact: false,
          },
        ]
      : []),
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
      variant="inset"
      collapsible="icon"
      mobileTitle={t('nav.label')}
      mobileDescription={t('nav.mobileDescription')}
      className="border-none bg-transparent font-sans"
    >
      {/* Navigation Drawer Header */}
      <SidebarHeader className="gap-2 p-3 pb-2 group-data-[collapsible=icon]:p-2 group-data-[collapsible=icon]:items-center">
        <div className="flex items-center justify-between gap-2 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:gap-1 group-data-[collapsible=icon]:items-center">
          <Link
            href={PLATFORM_ROUTES.dashboard}
            className="flex items-center gap-2 rounded-md px-1 py-1 text-foreground transition-colors hover:bg-sidebar-accent outline-none focus-visible:ring-2 focus-visible:ring-ring group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:justify-center"
          >
            <BrandMark />
            <span className="truncate text-sm font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
              {publicConfig.appName}
            </span>
          </Link>

          <SidebarTrigger
            label={t('nav.toggle')}
            className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
          />
        </div>

        {/* Workspace Switcher */}
        <OrganizationSwitcher />

        {/* Quick Search Trigger Input */}
        <button
          type="button"
          aria-label={t('nav.search')}
          className="group flex h-8 w-full items-center justify-between gap-2 rounded-md border border-border/40 bg-secondary px-2.5 text-xs text-muted-foreground transition-colors hover:border-border hover:bg-muted group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:p-0 group-data-[collapsible=icon]:justify-center"
          onClick={() => {
            const searchInput = document.querySelector<HTMLInputElement>(
              'input[type="search"]',
            );
            if (searchInput) searchInput.focus();
          }}
        >
          <div className="flex items-center gap-2 group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:justify-center">
            <Search className="size-3.5 text-muted-foreground group-hover:text-foreground" />
            <span className="truncate group-data-[collapsible=icon]:hidden">
              {t('nav.search')}
            </span>
          </div>
          <kbd className="inline-flex h-4 items-center gap-0.5 rounded border border-border/60 bg-background px-1 text-xs font-mono text-muted-foreground group-data-[collapsible=icon]:hidden">
            <Command className="size-2.5" />K
          </kbd>
        </button>
      </SidebarHeader>

      <SidebarSeparator className="my-1 opacity-60" />

      {/* Navigation Drawer Content */}
      <SidebarContent className="px-2 group-data-[collapsible=icon]:px-1">
        <SidebarGroup className="p-1 group-data-[collapsible=icon]:p-0 group-data-[collapsible=icon]:items-center">
          <SidebarGroupLabel className="px-2 py-1 text-xs uppercase tracking-wider text-sidebar-section-title group-data-[collapsible=icon]:hidden">
            {t('nav.platformGroup')}
          </SidebarGroupLabel>

          <SidebarGroupContent className="mt-0.5 group-data-[collapsible=icon]:w-full">
            <SidebarMenu className="gap-0.5 group-data-[collapsible=icon]:items-center">
              {primary.map((item) => {
                const active = isCurrent(item);
                return (
                  <SidebarMenuItem
                    key={item.href}
                    className="group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center"
                  >
                    <SidebarMenuButton
                      asChild
                      isActive={active}
                      tooltip={item.label}
                      className={`group relative flex h-8 w-full items-center justify-between rounded-md px-2 py-1 text-xs transition-colors group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0 ${
                        active
                          ? 'bg-sidebar-active text-foreground'
                          : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-foreground'
                      }`}
                    >
                      <Link
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        className="flex w-full items-center justify-between group-data-[collapsible=icon]:w-auto group-data-[collapsible=icon]:justify-center"
                      >
                        <div className="flex items-center gap-2 truncate group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:justify-center">
                          <item.Icon
                            className={`size-4 shrink-0 ${active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground'}`}
                          />
                          <span className="truncate group-data-[collapsible=icon]:hidden">
                            {item.label}
                          </span>
                        </div>

                        {item.shortcut && (
                          <span
                            aria-hidden="true"
                            className="text-xs font-mono text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity group-data-[collapsible=icon]:hidden"
                          >
                            {item.shortcut}
                          </span>
                        )}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {current ? (
          <SidebarGroup className="p-1 group-data-[collapsible=icon]:p-0 group-data-[collapsible=icon]:items-center">
            <SidebarGroupLabel className="px-2 py-1 text-xs uppercase tracking-wider text-sidebar-section-title group-data-[collapsible=icon]:hidden">
              <span className="truncate">{current.name}</span>
            </SidebarGroupLabel>

            <SidebarGroupContent className="mt-0.5 group-data-[collapsible=icon]:w-full">
              <SidebarMenuSub className="ms-3 flex flex-col gap-0.5 border-s border-border/50 ps-2 py-0.5 group-data-[collapsible=icon]:ms-0 group-data-[collapsible=icon]:border-none group-data-[collapsible=icon]:ps-0 group-data-[collapsible=icon]:items-center">
                {organizationSections.map((item) => {
                  const active = isCurrent(item);
                  return (
                    <SidebarMenuSubItem
                      key={item.href}
                      className="group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center"
                    >
                      <SidebarMenuSubButton
                        asChild
                        isActive={active}
                        className={`flex h-7 w-full items-center gap-2 rounded-md px-2 text-xs transition-colors group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0 ${
                          active
                            ? 'bg-sidebar-active text-foreground font-medium'
                            : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-foreground'
                        }`}
                      >
                        <Link
                          href={item.href}
                          aria-current={active ? 'page' : undefined}
                          className="flex items-center gap-2 truncate group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:justify-center"
                        >
                          <item.Icon
                            className={`size-3.5 shrink-0 ${active ? 'text-primary' : 'text-muted-foreground'}`}
                          />
                          <span className="truncate group-data-[collapsible=icon]:hidden">
                            {item.label}
                          </span>
                        </Link>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  );
                })}
              </SidebarMenuSub>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}
      </SidebarContent>

      <SidebarSeparator className="my-1 opacity-60" />

      {/* Navigation Drawer Footer */}
      <SidebarFooter className="p-2 pt-1 group-data-[collapsible=icon]:p-2 group-data-[collapsible=icon]:items-center">
        <div className="flex items-center justify-between gap-1 rounded-md bg-secondary p-1.5 border border-border/40 group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:border-none group-data-[collapsible=icon]:p-0 group-data-[collapsible=icon]:justify-center">
          <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
            <UserAccountMenu variant="full" />
          </div>
          <div className="hidden group-data-[collapsible=icon]:block">
            <UserAccountMenu variant="compact" />
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
