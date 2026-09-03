'use client';

import { Badge, Button, Card, CardContent, buttonVariants } from '@repo/ui';
import { Archive, Loader2, RotateCcw } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';

import { EmptyState } from '@/components/empty-state';
import { PLATFORM_ROUTES } from '@/features/auth/routes';
import { usePlatformSession } from '@/features/auth/use-platform-session';
import { Link } from '@/i18n/navigation';

import { OrganizationAvatar } from '../components/organization-avatar';
import { OrganizationErrorAlert } from '../components/organization-error-alert';
import { OrganizationRoleLabel } from '../components/organization-role-label';
import { OrganizationTabs } from '../components/organization-tabs';
import { useRestoreOrganization } from '../hooks/use-organization-settings';
import type { OrganizationData } from '../route-data';
import { OrganizationProvider, type OrganizationContext } from '../organization-context';
import type { ArchivedOrganization } from '../organization-types';

/**
 * The frame around one organization, and the place its three possible states
 * are resolved.
 *
 * Doing the narrowing here rather than in each tab is what lets the tabs be
 * simple: by the time one renders, the organization exists, the reader is a
 * member of it, and both facts are in the outlet context. No tab carries a
 * branch for "archived" or "could not load".
 */
export function OrganizationShellBlock({
  children,
  data,
}: {
  children?: ReactNode;
  data: OrganizationData;
}) {
  const session = usePlatformSession();

  if (data.state === 'archived') {
    return (
      <ArchivedOrganizationView
        organizationId={data.organizationId}
        restorable={data.restorable}
      />
    );
  }

  if (data.state === 'error') {
    return <UnavailableOrganizationView />;
  }

  const { organization } = data;

  const context: OrganizationContext = {
    organization,
    viewer: {
      userId: session.user.id,
      member:
        organization.members.find(
          (member) => member.userId === session.user.id,
        ) ?? null,
    },
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <OrganizationAvatar logo={organization.logo} size="lg" />

        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-bold tracking-tight">
            {organization.name}
          </h1>
          <bdi className="block truncate text-sm text-muted-foreground">
            {organization.slug}
          </bdi>
        </div>

        {context.viewer.member ? (
          <Badge variant="secondary" className="shrink-0">
            <OrganizationRoleLabel role={context.viewer.member.role} />
          </Badge>
        ) : null}
      </div>

      <OrganizationTabs organizationId={organization.id} />

      <OrganizationProvider value={context}>{children}</OrganizationProvider>
    </div>
  );
}

/**
 * An organization that has been taken offline.
 *
 * Reached by being refused: the backend makes every organization endpoint
 * inert for an archived organization, so this page exists precisely because
 * the normal one cannot load. The copy is careful about what archived means —
 * nothing was deleted — because the reader arriving here is often the person
 * who archived it and is now wondering whether they lost something.
 *
 * Restore appears only when the server listed this organization as restorable
 * for this caller. There is no role comparison here and there could not be
 * one: the answer came from the endpoint that will also enforce it.
 */
function ArchivedOrganizationView({
  organizationId,
  restorable,
}: {
  organizationId: string;
  restorable: ArchivedOrganization | null;
}) {
  const t = useTranslations('Organization');
  const restore = useRestoreOrganization(organizationId);

  return (
    <Card className="mx-auto w-full max-w-2xl">
      <CardContent className="space-y-5">
        <EmptyState
          icon={<Archive className="size-5" />}
          title={t('archived.title', { name: restorable?.name ?? '' })}
          description={t('archived.description')}
          className="border-0 px-0 py-2"
        />

        <ul className="space-y-2 rounded-lg bg-muted p-4 text-sm leading-6 text-muted-foreground">
          <li>{t('archived.preservedMembers')}</li>
          <li>{t('archived.preservedResources')}</li>
          <li>{t('archived.canceledInvitations')}</li>
        </ul>

        <OrganizationErrorAlert error={restore.error} />

        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          {restorable ? (
            <Button
              className="flex-1 gap-2"
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

          <Link
            href={PLATFORM_ROUTES.organizations}
            className={buttonVariants({
              variant: 'outline',
              className: 'flex-1',
            })}
          >
            {t('archived.backToList')}
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The organization could not be opened, and not because it is archived.
 *
 * One screen for every remaining reason — it does not exist, the reader is not
 * a member, the request failed — because from here they have the same remedy
 * and telling a non-member that an organization exists would answer a question
 * the backend declined to answer.
 */
function UnavailableOrganizationView() {
  const t = useTranslations('Organization');

  return (
    <Card className="mx-auto w-full max-w-2xl">
      <CardContent>
        <EmptyState
          title={t('unavailable.title')}
          description={t('unavailable.description')}
          className="border-0"
          action={
            <Link
              href={PLATFORM_ROUTES.organizations}
              className={buttonVariants({ variant: 'outline' })}
            >
              {t('archived.backToList')}
            </Link>
          }
        />
      </CardContent>
    </Card>
  );
}
