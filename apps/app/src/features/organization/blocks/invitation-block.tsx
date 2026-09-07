'use client';

import {
  Alert,
  AlertDescription,
  AlertTitle,
  Avatar,
  AvatarFallback,
  Button,
  Separator,
} from '@repo/ui';
import { AlertCircle, Building2, Check, Loader2, X } from 'lucide-react';
import { useFormatter, useTranslations } from 'use-intl';

import { AuthCard } from '@/features/auth/components/auth-card';

import { OrganizationRoleLabel } from '../components/organization-role-label';
import { useInvitationResponse } from '../hooks/use-invitation-response';
import type { InvitationDetails } from '../invitation-state';

export function InvitationBlock({
  invitation,
}: {
  invitation: InvitationDetails;
}) {
  const t = useTranslations('Organization');
  const format = useFormatter();
  const response = useInvitationResponse(invitation.id);

  const isBusy = response.pending !== null;

  return (
    <AuthCard
      title={t('invitation.title')}
      description={t.rich('invitation.description', {
        organization: invitation.organizationName,
        name: (chunks) => (
          <span className="font-medium text-foreground">{chunks}</span>
        ),
      })}
    >
      {response.failure ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>{t('invitation.failureTitle')}</AlertTitle>
          <AlertDescription>
            <p>{t(`invitation.failures.${response.failure}`)}</p>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex items-center gap-3 rounded-lg border p-4">
        <Avatar size="lg" className="rounded-lg">
          <AvatarFallback className="rounded-lg">
            <Building2 className="size-5" />
          </AvatarFallback>
        </Avatar>

        <div className="min-w-0">
          <div className="truncate font-medium">
            {invitation.organizationName}
          </div>
          <div className="truncate text-sm text-muted-foreground">
            <bdi>{invitation.organizationSlug}</bdi>
          </div>
        </div>
      </div>

      <Separator />

      <dl className="space-y-3 text-sm">
        <DetailRow label={t('invitation.invitedAs')}>
          <OrganizationRoleLabel role={invitation.role} />
        </DetailRow>

        <DetailRow label={t('invitation.invitedEmail')}>
          {/* An email is left-to-right text; isolate it inside Arabic copy. */}
          <bdi>{invitation.email}</bdi>
        </DetailRow>

        <DetailRow label={t('invitation.invitedBy')}>
          <bdi>{invitation.inviterEmail}</bdi>
        </DetailRow>

        <DetailRow label={t('invitation.expiresAt')}>
          {format.dateTime(new Date(invitation.expiresAt), {
            dateStyle: 'long',
            timeStyle: 'short',
          })}
        </DetailRow>
      </dl>

      <div className="flex flex-col gap-2 sm:flex-row-reverse">
        <Button
          className="flex-1"
          onClick={() => void response.accept()}
          disabled={isBusy}
          aria-busy={response.pending === 'accept'}
        >
          {response.pending === 'accept' ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Check />
          )}
          {t('invitation.accept')}
        </Button>

        <Button
          variant="outline"
          className="flex-1"
          onClick={() => void response.reject()}
          disabled={isBusy}
          aria-busy={response.pending === 'reject'}
        >
          {response.pending === 'reject' ? (
            <Loader2 className="animate-spin" />
          ) : (
            <X />
          )}
          {t('invitation.decline')}
        </Button>
      </div>
    </AuthCard>
  );
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate font-medium">{children}</dd>
    </div>
  );
}
