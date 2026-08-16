import { Badge, Skeleton } from '@repo/ui';
import { Building2 } from 'lucide-react';
import { useTranslations } from 'use-intl';

import { authClient } from '@/features/auth/auth-client';

import { OrganizationRoleLabel } from './organization-role-label';

/**
 * Shows which organization is active and what the user is inside it.
 *
 * Two separate reads, deliberately. `useActiveOrganization` answers "which
 * organization", `useActiveMember` answers "what am I here" — and they can
 * legitimately disagree: a session can carry an `activeOrganizationId` for an
 * organization the user has no membership in, in which case there is a name
 * to show and no role.
 *
 * Rendering that honestly is the point. It is the same invariant the backend
 * enforces — an active organization is context, never proof of access — and a
 * component that assumed the role must exist would be quietly asserting the
 * opposite.
 */
export function ActiveOrganization() {
  const t = useTranslations('Organization');
  const organization = authClient.useActiveOrganization();
  const member = authClient.useActiveMember();

  if (organization.isPending) {
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
