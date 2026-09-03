import {
  Avatar,
  AvatarFallback,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Skeleton,
} from '@repo/ui';
import { Building2, Check, ChevronDown, Loader2 } from 'lucide-react';
import { useTranslations } from 'use-intl';

import { userInitials } from '@/lib/user-initials';
import { useOrganizationSwitcher } from '../hooks/use-organization-switcher';

export function OrganizationSwitcher() {
  const t = useTranslations('Organization');
  const { organizations, activeOrganization, isLoading, pendingId, switchTo } =
    useOrganizationSwitcher();

  if (isLoading) {
    return (
      <Skeleton
        className="h-8 w-full rounded-md"
        aria-label={t('switcher.loading')}
      />
    );
  }

  if (organizations.length === 0) {
    return (
      <div className="flex h-8 items-center gap-2 rounded-md border border-border/50 bg-background/50 px-2.5 text-xs text-muted-foreground">
        <Building2 className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{t('switcher.none')}</span>
      </div>
    );
  }

  const activeName = activeOrganization?.name ?? t('switcher.placeholder');
  const initials = userInitials(activeName, activeName);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="group flex h-8 w-full items-center justify-between gap-2 rounded-md border border-transparent px-2 text-start text-sm font-medium transition-colors hover:border-border hover:bg-sidebar-accent focus-visible:ring-1 focus-visible:ring-ring group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:justify-center"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2 group-data-[collapsible=icon]:flex-none">
            <Avatar
              aria-hidden="true"
              className="size-5 rounded border border-border/60 bg-muted/60 text-xs font-semibold text-foreground"
            >
              <AvatarFallback className="rounded bg-primary/10 text-primary">
                {initials}
              </AvatarFallback>
            </Avatar>

            <span className="sr-only">{t('switcher.label')}</span>

            <span className="truncate text-xs font-semibold text-foreground group-data-[collapsible=icon]:hidden">
              {activeName}
            </span>
          </div>

          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180 group-data-[collapsible=icon]:hidden" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        className="w-64 rounded-md border border-border shadow-md"
      >
        <DropdownMenuLabel className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {t('switcher.label')}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {organizations.map((organization) => {
          const isActive = organization.id === activeOrganization?.id;
          const isPending = organization.id === pendingId;
          const orgInitials = userInitials(
            organization.name,
            organization.name,
          );

          return (
            <DropdownMenuItem
              key={organization.id}
              disabled={isPending || isActive}
              className="flex items-center gap-2 rounded px-2 py-1.5 text-xs font-medium focus:bg-sidebar-active"
              onSelect={(event) => {
                event.preventDefault();
                void switchTo(organization.id);
              }}
            >
              <Avatar
                aria-hidden="true"
                className="size-5 rounded border border-border/40 text-xs font-medium"
              >
                <AvatarFallback className="rounded bg-muted text-muted-foreground">
                  {orgInitials}
                </AvatarFallback>
              </Avatar>

              <span className="truncate">{organization.name}</span>

              {isPending ? (
                <Loader2 className="ms-auto size-3.5 animate-spin" />
              ) : isActive ? (
                <Check className="ms-auto size-3.5 text-primary" />
              ) : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
