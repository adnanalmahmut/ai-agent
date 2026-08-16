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
import type { OrganizationsListData } from '@/features/organization/loaders';
import { Link } from '@/i18n/navigation';

/**
 * The authenticated landing page.
 *
 * Restrained on purpose. It shows what the session and the memberships
 * actually establish — who you are, whether your address is confirmed, which
 * organizations you belong to — and links onward. There are no KPI cards and
 * no charts, because there is no data behind them: a revenue graph on this
 * page would be a drawing, not a report.
 *
 * The interesting case is a reader with no organizations. That is the normal
 * state of a brand-new account, and since anyone verified may create one, this
 * page's empty state is where that starts rather than a dead end.
 */
export function DashboardBlock({ data }: { data: OrganizationsListData }) {
  const t = useTranslations('Platform');
  const session = usePlatformSession();

  const hasOrganizations = data.organizations.length > 0;

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('dashboard.greeting', {
          name: session.user.name ?? session.user.email,
        })}
        description={t('dashboard.description')}
      />

      <div className="grid gap-5 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('dashboard.account.title')}</CardTitle>
            <CardDescription>
              {t('dashboard.account.description')}
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-3 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-muted-foreground">
                {t('dashboard.account.email')}
              </span>
              <bdi className="font-medium">{session.user.email}</bdi>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-muted-foreground">
                {t('dashboard.account.verification')}
              </span>

              {session.user.emailVerified ? (
                <Badge variant="secondary">
                  <MailCheck />
                  {t('dashboard.account.verified')}
                </Badge>
              ) : (
                <Badge variant="outline">
                  <MailWarning />
                  {t('dashboard.account.unverified')}
                </Badge>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('dashboard.organization.title')}</CardTitle>
            <CardDescription>
              {t('dashboard.organization.description')}
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-3">
            <ActiveOrganization />

            <p className="text-sm leading-6 text-muted-foreground">
              {t('dashboard.organization.hint')}
            </p>
          </CardContent>
        </Card>
      </div>

      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold tracking-tight">
            {t('dashboard.organizations.title')}
          </h2>

          {hasOrganizations ? (
            <Link
              href={PLATFORM_ROUTES.organizations}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
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
                  className="block rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <Card className="h-full py-4 transition-colors hover:border-ring/40">
                    <CardContent className="flex items-center gap-3 px-4">
                      <Building2 className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate text-sm font-medium">
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
            icon={<Building2 className="size-5" />}
            title={t('dashboard.organizations.emptyTitle')}
            description={t('dashboard.organizations.emptyDescription')}
            action={
              <Link
                href={PLATFORM_ROUTES.newOrganization}
                className={buttonVariants({ className: 'gap-2' })}
              >
                <Plus />
                {t('dashboard.organizations.create')}
              </Link>
            }
          />
        )}
      </section>
    </div>
  );
}
