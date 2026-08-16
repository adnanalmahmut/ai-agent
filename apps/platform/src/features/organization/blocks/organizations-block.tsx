import {
  Badge,
  Button,
  Card,
  CardContent,
  buttonVariants,
} from '@repo/ui';
import { Archive, Building2, Loader2, Plus, RotateCcw } from 'lucide-react';
import { useTranslations } from 'use-intl';

import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { ORGANIZATION_ROUTES, PLATFORM_ROUTES } from '@/features/auth/routes';
import { Link } from '@/i18n/navigation';

import type { OrganizationsListData } from '../loaders';
import { useRestoreOrganization } from '../hooks/use-organization-settings';
import type { ArchivedOrganization } from '../organization-types';
import { OrganizationAvatar } from '../components/organization-avatar';
import { OrganizationErrorAlert } from '../components/organization-error-alert';

/**
 * Every organization the reader belongs to.
 *
 * The empty state is the one that matters most here and it is no longer a dead
 * end: creating an organization is something any verified user may do, so the
 * screen that says "you are in none" is also the screen that offers to fix
 * that. Before organization creation existed this state could only apologise.
 *
 * The archived section appears only when there is something in it, and every
 * row in it is one the *server* said this caller may restore — there is no
 * role check here, and none is possible: the list arrives pre-filtered.
 */
export function OrganizationsBlock({ data }: { data: OrganizationsListData }) {
  const t = useTranslations('Organization');

  const createAction = (
    <Link
      href={PLATFORM_ROUTES.newOrganization}
      className={buttonVariants({ className: 'gap-2' })}
    >
      <Plus />
      {t('list.create')}
    </Link>
  );

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('list.title')}
        description={t('list.description')}
        actions={data.organizations.length > 0 ? createAction : undefined}
      />

      <OrganizationErrorAlert error={data.error} />

      {data.organizations.length === 0 && !data.error ? (
        <EmptyState
          icon={<Building2 className="size-5" />}
          title={t('list.emptyTitle')}
          description={t('list.emptyDescription')}
          action={createAction}
        />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {data.organizations.map((organization) => (
            <li key={organization.id}>
              <Link
                href={ORGANIZATION_ROUTES.overview(organization.id)}
                className="block rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <Card className="h-full transition-colors hover:border-ring/40">
                  <CardContent className="flex items-center gap-3">
                    <OrganizationAvatar logo={organization.logo} size="lg" />

                    <div className="min-w-0">
                      <div className="truncate font-medium">
                        {organization.name}
                      </div>
                      <bdi className="block truncate text-sm text-muted-foreground">
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

/**
 * Organizations that are offline but recoverable.
 *
 * Kept visually quiet and behind its own heading: these are not places the
 * reader can work in, and mixing them into the grid above would invite a click
 * that leads to a page where nothing functions.
 */
function ArchivedSection({
  organizations,
}: {
  organizations: ArchivedOrganization[];
}) {
  const t = useTranslations('Organization');

  return (
    <section className="space-y-4">
      <div className="space-y-1.5">
        <h2 className="text-lg font-semibold tracking-tight">
          {t('list.archivedTitle')}
        </h2>
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
          {t('list.archivedDescription')}
        </p>
      </div>

      <ul className="space-y-3">
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
    <Card className="bg-muted/40 shadow-none">
      <CardContent className="flex flex-wrap items-center gap-3">
        <OrganizationAvatar logo={null} />

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium">{organization.name}</span>
            <Badge variant="outline" className="shrink-0 gap-1">
              <Archive />
              {t('list.archivedBadge')}
            </Badge>
          </div>
          <bdi className="block truncate text-sm text-muted-foreground">
            {organization.slug}
          </bdi>
        </div>

        {organization.canRestore ? (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 gap-2"
            onClick={() => void restore.submit()}
            disabled={restore.isPending}
            aria-busy={restore.isPending}
          >
            {restore.isPending ? (
              <Loader2 className="animate-spin" />
            ) : (
              <RotateCcw />
            )}
            {t('settings.restoreAction')}
          </Button>
        ) : null}
      </CardContent>

      {restore.error ? (
        <CardContent className="pt-0">
          <OrganizationErrorAlert error={restore.error} />
        </CardContent>
      ) : null}
    </Card>
  );
}
