'use client';

import { Badge, Button, Card, CardContent, buttonVariants } from '@repo/ui';
import { Archive, Building2, Loader2, Plus, RotateCcw } from 'lucide-react';
import { useTranslations } from 'use-intl';

import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { ORGANIZATION_ROUTES, PLATFORM_ROUTES } from '@/features/auth/routes';
import { Link } from '@/i18n/navigation';

import type { OrganizationsListData } from '../route-data';
import { useRestoreOrganization } from '../hooks/use-organization-settings';
import type { ArchivedOrganization } from '../organization-types';
import { OrganizationAvatar } from '../components/organization-avatar';
import { OrganizationErrorAlert } from '../components/organization-error-alert';

export function OrganizationsBlock({ data }: { data: OrganizationsListData }) {
  const t = useTranslations('Organization');

  const createAction = (
    <Link
      href={PLATFORM_ROUTES.newOrganization}
      className={buttonVariants({
        className: 'gap-2 h-8 text-xs font-semibold',
      })}
    >
      <Plus className="size-3.5" />
      {t('list.create')}
    </Link>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('list.title')}
        description={t('list.description')}
        actions={data.organizations.length > 0 ? createAction : undefined}
      />

      <OrganizationErrorAlert error={data.error} />

      {data.organizations.length === 0 && !data.error ? (
        <EmptyState
          icon={<Building2 className="size-5 text-muted-foreground" />}
          title={t('list.emptyTitle')}
          description={t('list.emptyDescription')}
          action={createAction}
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {data.organizations.map((organization) => (
            <li key={organization.id}>
              <Link
                href={ORGANIZATION_ROUTES.overview(organization.id)}
                className="block rounded-lg outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <Card className="h-full ds-card transition-colors hover:border-border hover:bg-sidebar-accent/50">
                  <CardContent className="flex items-center gap-3 p-4">
                    <OrganizationAvatar logo={organization.logo} size="lg" />

                    <div className="min-w-0">
                      <div className="truncate text-xs font-semibold text-foreground">
                        {organization.name}
                      </div>
                      <bdi className="block truncate text-xs text-muted-foreground">
                        {organization.slug}
                      </bdi>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {data.archived.length > 0 ? (
        <ArchivedSection organizations={data.archived} />
      ) : null}
    </div>
  );
}

function ArchivedSection({
  organizations,
}: {
  organizations: ArchivedOrganization[];
}) {
  const t = useTranslations('Organization');

  return (
    <section className="space-y-3 pt-4 border-t border-border/40">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          {t('list.archivedTitle')}
        </h2>
        <p className="max-w-2xl text-xs text-muted-foreground">
          {t('list.archivedDescription')}
        </p>
      </div>

      <ul className="space-y-2">
        {organizations.map((organization) => (
          <li key={organization.id}>
            <ArchivedRow organization={organization} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ArchivedRow({ organization }: { organization: ArchivedOrganization }) {
  const t = useTranslations('Organization');
  const restore = useRestoreOrganization(organization.id);

  return (
    <Card className="border border-border/50 bg-muted/40 shadow-none rounded-lg">
      <CardContent className="flex flex-wrap items-center gap-3 p-3">
        <OrganizationAvatar logo={null} />

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-xs font-semibold text-foreground">
              {organization.name}
            </span>
            <Badge
              variant="outline"
              className="shrink-0 gap-1 text-xs border-border/40"
            >
              <Archive className="size-3" />
              {t('list.archivedBadge')}
            </Badge>
          </div>
          <bdi className="block truncate text-xs text-muted-foreground">
            {organization.slug}
          </bdi>
        </div>

        {organization.canRestore ? (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 gap-1.5 h-7 text-xs border border-border/50 hover:bg-sidebar-accent"
            onClick={() => void restore.submit()}
            disabled={restore.isPending}
            aria-busy={restore.isPending}
          >
            {restore.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RotateCcw className="size-3.5" />
            )}
            {t('settings.restoreAction')}
          </Button>
        ) : null}
      </CardContent>

      {restore.error ? (
        <CardContent className="p-3 pt-0">
          <OrganizationErrorAlert error={restore.error} />
        </CardContent>
      ) : null}
    </Card>
  );
}
