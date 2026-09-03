import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  Button,
  Card,
  CardContent,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@repo/ui';
import { Ban, CheckCircle2, Shield, UserCheck, UserX } from 'lucide-react';
import { useTranslations } from 'use-intl';

import { usePlatformSession } from '@/features/auth/use-platform-session';
import {
  ASSIGNABLE_GLOBAL_ROLE_NAMES,
  type AssignableGlobalRoleName,
  isElevatedRole,
  isSuperAdminRole,
} from '@/features/authorization/permissions';
import { useGlobalPermission } from '@/features/authorization/use-permissions';
import { userInitials } from '@/lib/user-initials';

export type AdminUserInfo = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
  role?: string;
  banned?: boolean;
  banReason?: string | null;
  deletedAt?: string | null;
  createdAt: string;
};

type AdminUsersTableProps = {
  users: AdminUserInfo[];
  actionUserId: string | null;
  onRoleChange: (userId: string, newRole: AssignableGlobalRoleName) => void;
  onBanClick: (user: AdminUserInfo) => void;
  onUnban: (userId: string) => void;
  onDeactivate: (userId: string) => void;
  onRestore: (userId: string) => void;
  onImpersonate: (userId: string) => void;
};

export function AdminUsersTable({
  users,
  actionUserId,
  onRoleChange,
  onBanClick,
  onUnban,
  onDeactivate,
  onRestore,
  onImpersonate,
}: AdminUsersTableProps) {
  const t = useTranslations('AdminUsers');
  const session = usePlatformSession();

  const canSetRole = useGlobalPermission({ user: ['set-role'] });
  const canBan = useGlobalPermission({ user: ['ban'] });
  const canImpersonate = useGlobalPermission({ user: ['impersonate'] });
  const canImpersonateAdmins = useGlobalPermission({
    user: ['impersonate-admins'],
  });
  const canDeactivate = useGlobalPermission({
    accountLifecycle: ['deactivate'],
  });
  const canRestore = useGlobalPermission({ accountLifecycle: ['restore'] });

  const currentUserId = session.user.id;

  if (users.length === 0) {
    return (
      <div className="p-8 text-center text-xs text-muted-foreground">
        {t('empty')}
      </div>
    );
  }

  return (
    <Card className="ds-card overflow-hidden py-0">
      <CardContent className="p-0">
        <Table>
          <TableHeader className="ds-table-header">
            <TableRow className="hover:bg-transparent">
              <TableHead className="ds-table-head">
                {t('columns.user')}
              </TableHead>
              <TableHead className="ds-table-head">
                {t('columns.role')}
              </TableHead>
              <TableHead className="ds-table-head">
                {t('columns.status')}
              </TableHead>
              <TableHead className="py-2.5 px-3">
                <span className="sr-only">{t('columns.actions')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            {users.map((user) => {
              const initials = userInitials(user.name, user.email);
              const isActionPending = actionUserId === user.id;
              const isSelf = user.id === currentUserId;
              const isTargetAdmin = isElevatedRole(user.role);
              const isTargetSuperAdmin = isSuperAdminRole(user.role);

              const allowImpersonate =
                canImpersonate &&
                !isSelf &&
                (!isTargetAdmin || canImpersonateAdmins);

              const roleValue = user.role || 'user';

              return (
                <TableRow
                  key={user.id}
                  className="border-b border-border/30 hover:bg-sidebar-accent/50 transition-colors"
                >
                  <TableCell className="py-2.5 px-3">
                    <div className="flex items-center gap-2.5">
                      <Avatar className="size-7 border border-border/50">
                        {user.image ? (
                          <AvatarImage src={user.image} alt="" />
                        ) : null}
                        <AvatarFallback className="text-xs font-semibold bg-primary/10 text-primary">
                          {initials}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-foreground truncate">
                          {user.name || user.email}
                        </div>
                        <bdi className="block truncate text-2xs text-muted-foreground">
                          {user.email}
                        </bdi>
                      </div>
                    </div>
                  </TableCell>

                  <TableCell className="py-2.5 px-3">
                    {canSetRole && !isSelf && !isTargetSuperAdmin ? (
                      <Select
                        value={roleValue}
                        onValueChange={(val) =>
                          onRoleChange(user.id, val as AssignableGlobalRoleName)
                        }
                        disabled={isActionPending}
                      >
                        <SelectTrigger className="h-7 w-32 text-2xs border-border/50 bg-background">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ASSIGNABLE_GLOBAL_ROLE_NAMES.map((roleKey) => (
                            <SelectItem
                              key={roleKey}
                              value={roleKey}
                              className="text-xs"
                            >
                              {t(`roles.${roleKey}`, { defaultValue: roleKey })}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Badge
                        variant="outline"
                        className="text-2xs border-border/60"
                      >
                        {t(`roles.${roleValue}`, { defaultValue: roleValue })}
                      </Badge>
                    )}
                  </TableCell>

                  <TableCell className="py-2.5 px-3">
                    <div className="flex flex-wrap items-center gap-1">
                      {user.banned ? (
                        <Badge
                          variant="destructive"
                          className="text-2xs rounded px-1.5 py-0.2"
                        >
                          {t('status.banned')}
                        </Badge>
                      ) : user.deletedAt ? (
                        <Badge
                          variant="outline"
                          className="text-2xs rounded px-1.5 py-0.2 border-amber-500/40 text-amber-600 dark:text-amber-400"
                        >
                          {t('status.deactivated')}
                        </Badge>
                      ) : user.emailVerified ? (
                        <Badge
                          variant="secondary"
                          className="text-2xs rounded px-1.5 py-0.2"
                        >
                          {t('status.verified')}
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="text-2xs rounded px-1.5 py-0.2"
                        >
                          {t('status.unverified')}
                        </Badge>
                      )}
                    </div>
                  </TableCell>

                  <TableCell className="py-2.5 px-3 text-end">
                    <div className="flex items-center justify-end gap-1">
                      {allowImpersonate ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          title={t('actions.impersonate')}
                          disabled={isActionPending}
                          onClick={() => onImpersonate(user.id)}
                          className="h-7 px-2 text-2xs"
                        >
                          <UserCheck className="size-3.5 text-muted-foreground" />
                        </Button>
                      ) : null}

                      {canBan && !isSelf ? (
                        user.banned ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            title={t('actions.unban')}
                            disabled={isActionPending}
                            onClick={() => onUnban(user.id)}
                            className="h-7 px-2 text-2xs text-emerald-600 dark:text-emerald-400"
                          >
                            <Shield className="size-3.5" />
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            title={t('actions.ban')}
                            disabled={isActionPending}
                            onClick={() => onBanClick(user)}
                            className="h-7 px-2 text-2xs text-destructive"
                          >
                            <Ban className="size-3.5" />
                          </Button>
                        )
                      ) : null}

                      {!isSelf ? (
                        user.deletedAt && canRestore ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            title={t('actions.restore')}
                            disabled={isActionPending}
                            onClick={() => onRestore(user.id)}
                            className="h-7 px-2 text-2xs text-primary"
                          >
                            <CheckCircle2 className="size-3.5" />
                          </Button>
                        ) : !user.deletedAt && canDeactivate ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            title={t('actions.deactivate')}
                            disabled={isActionPending}
                            onClick={() => onDeactivate(user.id)}
                            className="h-7 px-2 text-2xs text-amber-600 dark:text-amber-400"
                          >
                            <UserX className="size-3.5" />
                          </Button>
                        ) : null
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
