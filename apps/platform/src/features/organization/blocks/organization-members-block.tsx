import {
  Badge,
  Button,
  Card,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@repo/ui';
import { Loader2, UserMinus } from 'lucide-react';
import { useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageHeader } from '@/components/page-header';
import { PersonIdentity } from '@/components/person-identity';
import type { OrganizationRoleName } from '@/features/authorization/permissions';
import { useOrganizationRolePermission } from '@/features/authorization/use-permissions';

import { OrganizationErrorAlert } from '../components/organization-error-alert';
import { OrganizationRoleLabel } from '../components/organization-role-label';
import { OrganizationRoleSelect } from '../components/organization-role-select';
import { useMemberActions } from '../hooks/use-member-actions';
import { useOrganizationContext } from '../organization-context';
import type { OrganizationMember } from '../organization-types';

/**
 * Who is in this organization, and what can be done about it.
 *
 * The two permissions are asked separately — changing a role and removing
 * someone are different capabilities, and an installation could grant one
 * without the other — and both are asked against the reader's membership *in
 * this organization*, not in whichever one is active.
 *
 * Neither answer is a security boundary. Every control here calls an endpoint
 * that re-derives the same decision from the database; hiding a button only
 * stops a reader from being shown a door that opens onto a 403.
 *
 * Two layouts, one set of controls: a table from `lg` up, cards below it.
 * The breakpoint is `lg` rather than `md` because the sidebar takes 16rem of
 * the width — at 834px that leaves the table under 600px, and it was measured
 * overflowing by 163px. The usual compromise, letting it scroll sideways,
 * pushes the row's actions off-screen, which is the one thing the reader came
 * for.
 */
export function OrganizationMembersBlock() {
  const t = useTranslations('Organization');
  const { organization, viewer } = useOrganizationContext();

  const canUpdateRole = useOrganizationRolePermission(viewer.member?.role, {
    member: ['update'],
  });
  const canRemove = useOrganizationRolePermission(viewer.member?.role, {
    member: ['delete'],
  });

  const actions = useMemberActions({
    organizationId: organization.id,
    currentUserId: viewer.userId,
  });

  const [pendingRemoval, setPendingRemoval] =
    useState<OrganizationMember | null>(null);

  const members = organization.members;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('members.title')}
        description={t('members.description')}
      />

      <OrganizationErrorAlert error={actions.error} />

      <Card className="ds-card overflow-hidden py-0">
        {/* Wide screens: a real table, with headers a screen reader can use. */}
        <div className="hidden lg:block">
          <Table>
            <TableHeader className="ds-table-header">
              <TableRow className="hover:bg-transparent">
                <TableHead className="ds-table-head">{t('members.columnMember')}</TableHead>
                <TableHead className="ds-table-head">{t('members.columnRole')}</TableHead>
                <TableHead className="ds-table-head">{t('members.columnJoined')}</TableHead>
                <TableHead className="py-2.5 px-3">
                  <span className="sr-only">{t('members.columnActions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>

            <TableBody>
              {members.map((member) => (
                <TableRow key={member.id} className="border-b border-border/30 hover:bg-sidebar-accent/50 transition-colors">
                  <TableCell className="py-2.5 px-3">
                    <PersonIdentity
                      name={member.user.name}
                      email={member.user.email}
                      image={member.user.image}
                    />
                  </TableCell>

                  <TableCell className="py-2.5 px-3">
                    <RoleControl
                      member={member}
                      canUpdate={canUpdateRole}
                      isPending={actions.pendingMemberId === member.id}
                      onChange={(role) =>
                        void actions.updateRole(member.id, role)
                      }
                    />
                  </TableCell>

                  <TableCell className="text-xs text-muted-foreground py-2.5 px-3">
                    <JoinedAt value={member.createdAt} />
                  </TableCell>

                  <TableCell className="text-end py-2.5 px-3">
                    {canRemove ? (
                      <RemoveButton
                        isPending={actions.pendingMemberId === member.id}
                        onSelect={() => setPendingRemoval(member)}
                        isSelf={member.userId === viewer.userId}
                      />
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {/* Narrower: one card per member, same controls, no sideways scroll. */}
        <ul className="divide-y lg:hidden">
          {members.map((member) => (
            <li key={member.id} className="space-y-3 p-4">
              <PersonIdentity
                name={member.user.name}
                email={member.user.email}
                image={member.user.image}
              />

              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="min-w-40 flex-1">
                  <RoleControl
                    member={member}
                    canUpdate={canUpdateRole}
                    isPending={actions.pendingMemberId === member.id}
                    onChange={(role) => void actions.updateRole(member.id, role)}
                  />
                </div>

                {canRemove ? (
                  <RemoveButton
                    isPending={actions.pendingMemberId === member.id}
                    onSelect={() => setPendingRemoval(member)}
                    isSelf={member.userId === viewer.userId}
                  />
                ) : null}
              </div>

              <p className="text-xs text-muted-foreground">
                {t('members.joinedOn')} <JoinedAt value={member.createdAt} />
              </p>
            </li>
          ))}
        </ul>
      </Card>

      <ConfirmDialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemoval(null);
        }}
        isDestructive
        isPending={actions.pendingMemberId !== null}
        title={
          pendingRemoval?.userId === viewer.userId
            ? t('members.leaveTitle')
            : t('members.removeTitle')
        }
        description={
          pendingRemoval?.userId === viewer.userId
            ? t('members.leaveDescription', { organization: organization.name })
            : t('members.removeDescription', {
                person: pendingRemoval?.user.name ?? pendingRemoval?.user.email ?? '',
              })
        }
        confirmLabel={
          pendingRemoval?.userId === viewer.userId
            ? t('members.leaveConfirm')
            : t('members.removeConfirm')
        }
        cancelLabel={t('members.cancel')}
        onConfirm={() => {
          const member = pendingRemoval;
          setPendingRemoval(null);
          if (member) void actions.removeMember(member.id, member.userId);
        }}
      >
        {/* Removing somebody does not delete anything they made. */}
        <p className="text-sm leading-6 text-muted-foreground">
          {t('members.removalPreserves')}
        </p>
      </ConfirmDialog>
    </div>
  );
}

/**
 * A member's role: editable when permitted, a plain badge when not.
 *
 * The read-only form is a `Badge` rather than a disabled select, because a
 * disabled control invites a reader to work out why they cannot use it. There
 * is nothing to work out — the role is simply information here.
 */
function RoleControl({
  member,
  canUpdate,
  isPending,
  onChange,
}: {
  member: OrganizationMember;
  canUpdate: boolean;
  isPending: boolean;
  onChange: (role: OrganizationRoleName) => void;
}) {
  const t = useTranslations('Organization');

  if (!canUpdate) {
    return (
      <Badge variant="secondary">
        <OrganizationRoleLabel role={member.role} />
      </Badge>
    );
  }

  return (
    <OrganizationRoleSelect
      hideLabel
      label={t('members.roleLabelFor', {
        person: member.user.name || member.user.email,
      })}
      value={member.role}
      onChange={onChange}
      disabled={isPending}
    />
  );
}

function RemoveButton({
  isPending,
  isSelf,
  onSelect,
}: {
  isPending: boolean;
  isSelf: boolean;
  onSelect: () => void;
}) {
  const t = useTranslations('Organization');

  return (
    <Button
      variant="ghost"
      size="sm"
      className="gap-2 text-destructive"
      onClick={onSelect}
      disabled={isPending}
      aria-busy={isPending}
    >
      {isPending ? <Loader2 className="animate-spin" /> : <UserMinus />}
      {isSelf ? t('members.leaveAction') : t('members.removeAction')}
    </Button>
  );
}

/** Membership dates come back as ISO strings over the wire. */
function JoinedAt({ value }: { value: string | Date }) {
  const format = useFormatter();

  return <>{format.dateTime(new Date(value), { dateStyle: 'medium' })}</>;
}
