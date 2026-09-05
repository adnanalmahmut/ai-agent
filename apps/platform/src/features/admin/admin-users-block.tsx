'use client';

import { Button, Input } from '@repo/ui';
import { Loader2, RefreshCw, Search, ShieldAlert } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';

import { PageHeader } from '@/components/page-header';
import { authClient } from '@/features/auth/auth-client';
import {
  type AssignableGlobalRoleName,
  isAssignableGlobalRoleName,
} from '@/features/authorization/permissions';
import { useGlobalPermission } from '@/features/authorization/use-permissions';
import {
  deactivateUserAccount,
  restoreUserAccount,
} from '@/lib/application-api';

import { BanUserDialog } from './admin-users-dialogs';
import { AdminUsersTable, type AdminUserInfo } from './admin-users-table';

export function AdminUsersBlock() {
  const t = useTranslations('AdminUsers');
  const canListUsers = useGlobalPermission({ user: ['list'] });

  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState<string | null>(null);
  const [banUser, setBanUser] = useState<AdminUserInfo | null>(null);
  const [banReason, setBanReason] = useState('');

  useEffect(() => {
    if (!canListUsers) return;
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [canListUsers, searchQuery]);

  const listing = useQuery({
    queryKey: ['admin', 'users', { search: debouncedSearch, limit: 100 }],
    enabled: canListUsers && debouncedSearch !== null,
    queryFn: async ({ signal }) => {
      const res = await authClient.admin.listUsers({
        query: { limit: 100, searchValue: debouncedSearch || undefined },
        fetchOptions: { signal },
      });
      if (res.error) throw res.error;
      return (res.data?.users ?? []) as unknown as AdminUserInfo[];
    },
  });
  const users = listing.data ?? [];
  const isLoading = listing.isPending || listing.isFetching;
  const loadError = listing.isError;
  const loadUsers = () => {
    if (debouncedSearch !== searchQuery) setDebouncedSearch(searchQuery);
    else void listing.refetch();
  };

  const action = useMutation({
    mutationFn: async (
      write:
        | { kind: 'role'; userId: string; role: AssignableGlobalRoleName }
        | { kind: 'ban'; userId: string; reason: string }
        | {
            kind: 'unban' | 'deactivate' | 'restore' | 'impersonate';
            userId: string;
          },
    ) => {
      // Better Auth reports protocol failures as data; transport failures
      // retain the screen's operation-specific fallback message.
      let result;
      try {
        switch (write.kind) {
          case 'role':
            result = await authClient.admin.setRole({
              userId: write.userId,
              role: write.role,
            });
            break;
          case 'ban':
            result = await authClient.admin.banUser({
              userId: write.userId,
              banReason: write.reason || 'Administrative ban',
            });
            break;
          case 'unban':
            result = await authClient.admin.unbanUser({ userId: write.userId });
            break;
          case 'deactivate':
            await deactivateUserAccount(write.userId);
            break;
          case 'restore':
            await restoreUserAccount(write.userId);
            break;
          case 'impersonate':
            result = await authClient.admin.impersonateUser({
              userId: write.userId,
            });
            break;
        }
      } catch {
        throw new Error(t(`errors.${write.kind}`));
      }
      if (result?.error)
        throw new Error(result.error.message || t(`errors.${write.kind}`));
    },
    onSuccess: async (_data, write) => {
      if (write.kind === 'impersonate') {
        window.location.reload();
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
  });
  const actionError = action.error?.message;
  const isBanning = action.isPending && action.variables.kind === 'ban';
  const actionUserId =
    action.isPending && action.variables.kind !== 'ban'
      ? action.variables.userId
      : null;
  const handleRoleChange = (userId: string, role: AssignableGlobalRoleName) => {
    if (isAssignableGlobalRoleName(role))
      action.mutate({ kind: 'role', userId, role });
  };
  const handleConfirmBan = () => {
    if (!banUser) return;
    action.mutate(
      { kind: 'ban', userId: banUser.id, reason: banReason },
      {
        onSuccess: () => {
          setBanUser(null);
          setBanReason('');
        },
      },
    );
  };

  if (!canListUsers) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('title')} description={t('description')} />
        <div className="flex items-start gap-2.5 rounded-md bg-destructive/10 border border-destructive/30 p-4 text-xs text-destructive">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-semibold">{t('accessDenied')}</p>
            <p className="mt-1">{t('accessDeniedDescription')}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('description')} />

      {actionError ? (
        <div className="flex items-start gap-2.5 rounded-md bg-destructive/10 border border-destructive/30 p-3 text-xs text-destructive">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          <p className="leading-5">{actionError}</p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative flex-1 min-w-60 max-w-md">
          <Search className="absolute start-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder={t('search')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="ps-8 h-9 text-xs rounded-md border-border/60 bg-background"
          />
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={() => void loadUsers()}
          disabled={isLoading}
          className="h-9 text-xs border-border/50 gap-1.5"
        >
          <RefreshCw
            className={`size-3.5 ${isLoading ? 'animate-spin' : ''}`}
          />
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center p-12 text-xs text-muted-foreground border border-border/60 rounded-lg bg-card">
          <Loader2 className="size-4 animate-spin me-2" /> {t('loading')}
        </div>
      ) : loadError ? (
        <div className="flex items-start gap-2.5 rounded-md bg-destructive/10 border border-destructive/30 p-4 text-xs text-destructive">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-semibold">{t('errors.load')}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void loadUsers()}
              className="mt-2 h-7 text-xs border-destructive/30 hover:bg-destructive/10"
            >
              {t('retry')}
            </Button>
          </div>
        </div>
      ) : (
        <AdminUsersTable
          users={users}
          actionUserId={actionUserId}
          onRoleChange={(userId, role) => void handleRoleChange(userId, role)}
          onBanClick={(user) => {
            setBanUser(user);
            setBanReason('');
          }}
          onUnban={(userId) => action.mutate({ kind: 'unban', userId })}
          onDeactivate={(userId) =>
            action.mutate({ kind: 'deactivate', userId })
          }
          onRestore={(userId) => action.mutate({ kind: 'restore', userId })}
          onImpersonate={(userId) =>
            action.mutate({ kind: 'impersonate', userId })
          }
        />
      )}

      <BanUserDialog
        user={banUser}
        banReason={banReason}
        isBanning={isBanning}
        onReasonChange={setBanReason}
        onClose={() => setBanUser(null)}
        onConfirm={() => void handleConfirmBan()}
      />
    </div>
  );
}
