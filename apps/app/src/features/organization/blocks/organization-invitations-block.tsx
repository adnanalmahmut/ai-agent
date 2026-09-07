'use client';

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@repo/ui';
import { Loader2, MailCheck, MailPlus, X } from 'lucide-react';
import { useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';

import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { FormField } from '@/features/auth/components/form-field';
import { SubmitButton } from '@/features/auth/components/submit-button';
import {
  ORGANIZATION_ROLE_NAMES,
  type OrganizationRoleName,
} from '@/features/authorization/permissions';
import { useOrganizationRolePermission } from '@/features/authorization/use-permissions';
import { MIRRORED_ICON } from '@/components/directional-icon';

import { OrganizationErrorAlert } from '../components/organization-error-alert';
import { OrganizationRoleLabel } from '../components/organization-role-label';
import { OrganizationRoleSelect } from '../components/organization-role-select';
import { useCancelInvitation, useInviteMember } from '../hooks/use-invitations';
import { useOrganizationContext } from '../organization-context';
import type { OrganizationInvitation } from '../organization-types';

const DEFAULT_INVITE_ROLE = ORGANIZATION_ROLE_NAMES[0] as OrganizationRoleName;

const STATUS_VARIANT: Record<string, 'secondary' | 'outline'> = {
  pending: 'secondary',
};

export function OrganizationInvitationsBlock() {
  const t = useTranslations('Organization');
  const { organization, viewer } = useOrganizationContext();

  const canInvite = useOrganizationRolePermission(viewer.member?.role, {
    invitation: ['create'],
  });
  const canCancel = useOrganizationRolePermission(viewer.member?.role, {
    invitation: ['cancel'],
  });

  const invitations = [...organization.invitations].sort(byRecency);
  const pending = invitations.filter(
    (invitation) => invitation.status === 'pending',
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('invitations.title')}
        description={t('invitations.description')}
      />

      {canInvite ? <InviteForm organizationId={organization.id} /> : null}

      <Card className="border border-border/60 rounded-lg shadow-2xs overflow-hidden bg-card">
        <CardHeader className="p-4 pb-2 space-y-1">
          <CardTitle className="text-sm font-semibold tracking-tight text-foreground">
            {t('invitations.listTitle')}
          </CardTitle>
          <CardDescription className="text-xs text-muted-foreground">
            {t('invitations.pendingCount', { count: pending.length })}
          </CardDescription>
        </CardHeader>

        <CardContent className="p-0">
          {invitations.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title={t('invitations.emptyTitle')}
                description={t('invitations.emptyDescription')}
              />
            </div>
          ) : (
            <ul className="divide-y divide-border/40 border-t border-border/40">
              {invitations.map((invitation) => (
                <li
                  key={invitation.id}
                  className="hover:bg-sidebar-accent/50 transition-colors"
                >
                  <InvitationRow
                    invitation={invitation}
                    canCancel={canCancel}
                  />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function InviteForm({ organizationId }: { organizationId: string }) {
  const t = useTranslations('Organization');
  const invite = useInviteMember(organizationId);

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrganizationRoleName>(DEFAULT_INVITE_ROLE);

  return (
    <Card className="border border-border/60 rounded-lg shadow-2xs bg-card">
      <CardHeader className="p-4 pb-2 space-y-1">
        <CardTitle className="text-sm font-semibold tracking-tight text-foreground">
          {t('invitations.inviteTitle')}
        </CardTitle>
        <CardDescription className="text-xs text-muted-foreground">
          {t('invitations.inviteDescription')}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        <OrganizationErrorAlert error={invite.error} />

        {invite.invitedEmail ? (
          <div
            className="flex items-start gap-3 rounded-lg bg-muted p-4"
            aria-live="polite"
          >
            <MailCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p className="text-sm leading-6 text-muted-foreground">
              {t.rich('invitations.inviteSent', {
                email: invite.invitedEmail,
                address: (chunks) => (
                  <bdi className="font-medium text-foreground">{chunks}</bdi>
                ),
              })}
            </p>
          </div>
        ) : null}

        <form
          noValidate
          className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            void invite.submit({ email, role });
          }}
        >
          <div className="space-y-4 sm:col-span-2 sm:grid sm:grid-cols-2 sm:gap-4 sm:space-y-0">
            <FormField
              type="email"
              inputMode="email"
              autoComplete="email"
              required
              label={t('fields.inviteEmail')}
              placeholder={t('fields.emailPlaceholder')}
              value={email}
              issue={invite.issues.email}
              onChange={(event) => {
                setEmail(event.target.value);
                invite.reset();
              }}
            />

            <OrganizationRoleSelect
              label={t('fields.inviteRole')}
              value={role}
              onChange={(next) => {
                setRole(next);
                invite.reset();
              }}
              disabled={invite.isPending}
            />
          </div>

          <SubmitButton
            isPending={invite.isPending}
            icon={<MailPlus className={MIRRORED_ICON} />}
            className="w-full sm:w-auto"
          >
            {t('invitations.inviteSubmit')}
          </SubmitButton>
        </form>
      </CardContent>
    </Card>
  );
}

function InvitationRow({
  invitation,
  canCancel,
}: {
  invitation: OrganizationInvitation;
  canCancel: boolean;
}) {
  const t = useTranslations('Organization');
  const format = useFormatter();
  const cancel = useCancelInvitation();

  const isPending = invitation.status === 'pending';
  const isBusy = cancel.pendingInvitationId === invitation.id;

  return (
    <div className="space-y-3 px-6 py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <bdi className="min-w-0 flex-1 truncate font-medium">
          {invitation.email}
        </bdi>

        <Badge variant="outline" className="shrink-0">
          <OrganizationRoleLabel role={invitation.role} />
        </Badge>

        <Badge
          variant={STATUS_VARIANT[invitation.status] ?? 'outline'}
          className="shrink-0"
        >
          {t.has(`invitations.status.${invitation.status}`)
            ? t(`invitations.status.${invitation.status}`)
            : invitation.status}
        </Badge>

        {isPending && canCancel ? (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 gap-2 text-destructive"
            onClick={() => void cancel.cancel(invitation.id)}
            disabled={isBusy}
            aria-busy={isBusy}
          >
            {isBusy ? <Loader2 className="animate-spin" /> : <X />}
            {t('invitations.cancelAction')}
          </Button>
        ) : null}
      </div>

      <p className="text-xs text-muted-foreground">
        {isPending
          ? t('invitations.expiresOn', {
              date: format.dateTime(new Date(invitation.expiresAt), {
                dateStyle: 'medium',
                timeStyle: 'short',
              }),
            })
          : t('invitations.expiredOn', {
              date: format.dateTime(new Date(invitation.expiresAt), {
                dateStyle: 'medium',
              }),
            })}
      </p>

      <OrganizationErrorAlert error={cancel.error} />
    </div>
  );
}

function byRecency(a: OrganizationInvitation, b: OrganizationInvitation) {
  if (a.status !== b.status) {
    if (a.status === 'pending') return -1;
    if (b.status === 'pending') return 1;
  }

  return new Date(b.expiresAt).getTime() - new Date(a.expiresAt).getTime();
}
