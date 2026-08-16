import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Skeleton,
} from '@repo/ui';
import { Building2, Check, ChevronsUpDown, Loader2 } from 'lucide-react';
import { useTranslations } from 'use-intl';

import { useOrganizationSwitcher } from '../hooks/use-organization-switcher';

/**
 * Picks which organization the platform is currently about.
 *
 * Three states, and the middle one is the one usually forgotten: loading,
 * *no memberships at all*, and a list. A user with no organization is normal
 * here — membership arrives by invitation — so that state gets a sentence
 * explaining what will happen rather than an empty dropdown.
 *
 * Selecting an organization is context, not permission. It decides what the
 * platform is looking at; what the user may do to it is decided per action by
 * the organization permission gates, and ultimately by the server. This
 * component grants nothing.
 */
export function OrganizationSwitcher() {
  const t = useTranslations('Organization');
  const {
    organizations,
    activeOrganization,
    isLoading,
    pendingId,
    switchTo,
  } = useOrganizationSwitcher();

  if (isLoading) {
    return <Skeleton className="h-9 w-40" aria-label={t('switcher.loading')} />;
  }

  if (organizations.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-dashed px-3 py-1.5 text-sm text-muted-foreground">
        <Building2 className="size-4 shrink-0" />
        <span className="truncate">{t('switcher.none')}</span>
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="max-w-52 justify-between gap-2">
          <Building2 className="size-4 shrink-0 text-muted-foreground" />

          {/*
            A prefix rather than an `aria-label`: a label would *replace* the
            accessible name, leaving a screen-reader user with "Organization"
            and no idea which one is selected.
          */}
          <span className="sr-only">{t('switcher.label')}</span>

          <span className="truncate">
            {activeOrganization?.name ?? t('switcher.placeholder')}
          </span>

          {/* Neutral glyph: it points at the menu, not along the text. */}
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel>{t('switcher.label')}</DropdownMenuLabel>
        <DropdownMenuSeparator />

        {organizations.map((organization) => {
          const isActive = organization.id === activeOrganization?.id;
          const isPending = organization.id === pendingId;

          return (
            <DropdownMenuItem
              key={organization.id}
              disabled={isPending || isActive}
              onSelect={(event) => {
                event.preventDefault();
                void switchTo(organization.id);
              }}
            >
              <span className="truncate">{organization.name}</span>

              {isPending ? (
                <Loader2 className="ms-auto size-4 animate-spin" />
              ) : isActive ? (
                <Check className="ms-auto size-4" />
              ) : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
