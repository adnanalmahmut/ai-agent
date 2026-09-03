import { Badge, Skeleton } from '@repo/ui';
import { Building2 } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { useTranslations } from 'use-intl';

import { authClient } from '@/features/auth/auth-client';

import { OrganizationRoleLabel } from './organization-role-label';

const subscribeToHydration = () => () => undefined;

export function ActiveOrganization() {
  const t = useTranslations('Organization');
  const isHydrated = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );
  const organization = authClient.useActiveOrganization();
  const member = authClient.useActiveMember();

  if (!isHydrated || organization.isPending) {
    return <Skeleton className="h-5 w-32" aria-label={t('active.loading')} />;
  }

  if (!organization.data) {
    // A block, not an inline span: the parent stacks its children with
    // `space-y`, which has nothing to push against on an inline box.
    return (
      <div className="text-sm text-muted-foreground">{t('active.none')}</div>
    );
  }

  const role = member.data?.role;

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Building2 className="size-4 shrink-0 text-muted-foreground" />

      <span className="truncate text-sm font-medium">
        {organization.data.name}
      </span>

      {role ? (
        <Badge variant="secondary" className="shrink-0">
          <OrganizationRoleLabel role={role} />
        </Badge>
      ) : (
        <Badge variant="outline" className="shrink-0">
          {t('active.notAMember')}
        </Badge>
      )}
    </div>
  );
}
