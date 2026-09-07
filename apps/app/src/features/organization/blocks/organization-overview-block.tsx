'use client';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  buttonVariants,
} from '@repo/ui';
import { Mail, Users } from 'lucide-react';
import { useFormatter, useTranslations } from 'use-intl';

import { ORGANIZATION_ROUTES } from '@/features/auth/routes';
import { Link } from '@/i18n/navigation';

import { OrganizationRoleLabel } from '../components/organization-role-label';
import { useOrganizationContext } from '../organization-context';

export function OrganizationOverviewBlock() {
  const t = useTranslations('Organization');
  const format = useFormatter();
  const { organization, viewer } = useOrganizationContext();

  const pendingInvitations = organization.invitations.filter(
    (invitation) => invitation.status === 'pending',
  ).length;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <CountCard
          label={t('overview.memberCount')}
          value={format.number(organization.members.length)}
          icon={<Users className="size-4" />}
          href={ORGANIZATION_ROUTES.members(organization.id)}
          action={t('overview.viewMembers')}
        />

        <CountCard
          label={t('overview.pendingInvitationCount')}
          value={format.number(pendingInvitations)}
          icon={<Mail className="size-4" />}
          href={ORGANIZATION_ROUTES.invitations(organization.id)}
          action={t('overview.viewInvitations')}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('overview.detailsTitle')}</CardTitle>
          <CardDescription>{t('overview.detailsDescription')}</CardDescription>
        </CardHeader>

        <CardContent>
          <dl className="space-y-3 text-sm">
            <DetailRow label={t('fields.name')}>{organization.name}</DetailRow>

            <DetailRow label={t('fields.slug')}>
              {/* A slug is left-to-right text; isolate it inside Arabic copy. */}
              <bdi>{organization.slug}</bdi>
            </DetailRow>

            <DetailRow label={t('overview.createdAt')}>
              {format.dateTime(new Date(organization.createdAt), {
                dateStyle: 'long',
              })}
            </DetailRow>

            <DetailRow label={t('overview.yourRole')}>
              {viewer.member ? (
                <OrganizationRoleLabel role={viewer.member.role} />
              ) : (
                t('active.notAMember')
              )}
            </DetailRow>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}

function CountCard({
  label,
  value,
  icon,
  href,
  action,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  href: string;
  action: string;
}) {
  return (
    <Card>
      <CardHeader className="gap-1.5">
        <CardDescription className="flex items-center gap-2">
          <span aria-hidden className="[&>svg]:size-4">
            {icon}
          </span>
          {label}
        </CardDescription>
        <CardTitle className="text-3xl tabular-nums">{value}</CardTitle>
      </CardHeader>

      <CardContent>
        <Link
          href={href}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          {action}
        </Link>
      </CardContent>
    </Card>
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
