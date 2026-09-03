'use client';

import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  buttonVariants,
} from '@repo/ui';
import { ArrowRight, Building2, MailCheck, MailWarning, Plus } from 'lucide-react';
import { useTranslations } from 'use-intl';

import { MIRRORED_ICON } from '@/components/directional-icon';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { PLATFORM_ROUTES } from '@/features/auth/routes';
import { usePlatformSession } from '@/features/auth/use-platform-session';
import { ActiveOrganization } from '@/features/organization/components/active-organization';
import type { OrganizationsListData } from '@/features/organization/route-data';
import { Link } from '@/i18n/navigation';

/**
 * The authenticated landing page.
 */
export function DashboardBlock({ data }: { data: OrganizationsListData }) {
  const t = useTranslations('Platform');
  const session = usePlatformSession();

  const hasOrganizations = data.organizations.length > 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('dashboard.greeting', {
          name: session.user.name ?? session.user.email,
        })}
        description={t('dashboard.description')}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="ds-card">
          <CardHeader className="p-4 pb-2 space-y-1">
            <CardTitle className="text-sm font-semibold tracking-tight text-foreground">
              {t('dashboard.account.title')}
            </CardTitle>
            <CardDescription className="text-xs text-muted-foreground">
              {t('dashboard.account.description')}
            </CardDescription>
          </CardHeader>

          <CardContent className="p-4 pt-2 space-y-3 text-xs">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-muted-foreground">
                {t('dashboard.account.email')}
              </span>
              <bdi className="font-semibold text-foreground">{session.user.email}</bdi>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-muted-foreground">
                {t('dashboard.account.verification')}
              </span>

              {session.user.emailVerified ? (
                <Badge variant="secondary" className="gap-1.5 rounded px-2 py-0.5 text-xs font-medium border border-border/40">
                  <MailCheck className="size-3.5 text-primary" />
                  {t('dashboard.account.verified')}
                </Badge>
              ) : (
                <Badge variant="outline" className="gap-1.5 rounded px-2 py-0.5 text-xs font-medium border border-border/40">
                  <MailWarning className="size-3.5 text-destructive" />
                  {t('dashboard.account.unverified')}
                </Badge>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="ds-card">
          <CardHeader className="p-4 pb-2 space-y-1">
            <CardTitle className="text-sm font-semibold tracking-tight text-foreground">
              {t('dashboard.organization.title')}
            </CardTitle>
            <CardDescription className="text-xs text-muted-foreground">
              {t('dashboard.organization.description')}
            </CardDescription>
          </CardHeader>

          <CardContent className="p-4 pt-2 space-y-3">
            <ActiveOrganization />

            <p className="text-xs leading-5 text-muted-foreground">
              {t('dashboard.organization.hint')}
            </p>
          </CardContent>
        </Card>
      </div>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {t('dashboard.organizations.title')}
          </h2>

          {hasOrganizations ? (
            <Link
              href={PLATFORM_ROUTES.organizations}
              className={buttonVariants({ variant: 'outline', size: 'sm', className: 'h-7 text-xs border border-border/50 hover:bg-sidebar-accent' })}
            >
              {t('dashboard.organizations.viewAll')}
              <ArrowRight className={MIRRORED_ICON} />
            </Link>
          ) : null}
        </div>

        {hasOrganizations ? (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.organizations.slice(0, 6).map((organization) => (
              <li key={organization.id}>
                <Link
                  href={`${PLATFORM_ROUTES.organizations}/${organization.id}`}
                  className="block rounded-lg outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <Card className="h-full border border-border/60 py-3 rounded-lg shadow-2xs transition-colors hover:border-border hover:bg-sidebar-accent/50">
                    <CardContent className="flex items-center gap-3 px-4 py-1">
                      <Building2 className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate text-xs font-semibold text-foreground">
                        {organization.name}
                      </span>
                    </CardContent>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={<Building2 className="size-5 text-muted-foreground" />}
            title={t('dashboard.organizations.emptyTitle')}
            description={t('dashboard.organizations.emptyDescription')}
            action={
              <Link
                href={PLATFORM_ROUTES.newOrganization}
                className={buttonVariants({ className: 'gap-2 h-8 text-xs' })}
              >
                <Plus className="size-3.5" />
                {t('dashboard.organizations.create')}
              </Link>
            }
          />
        )}
      </section>
    </div>
  );
}
