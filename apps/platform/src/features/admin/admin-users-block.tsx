import { Button, Input } from '@repo/ui';
import { Loader2, RefreshCw, Search, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';

import { PageHeader } from '@/components/page-header';
import { authClient } from '@/features/auth/auth-client';
import {
  type AssignableGlobalRoleName,
  isAssignableGlobalRoleName,
} from '@/features/authorization/permissions';
import { useGlobalPermission } from '@/features/authorization/use-permissions';
import { deactivateUserAccount, restoreUserAccount } from '@/lib/application-api';

import { BanUserDialog } from './admin-users-dialogs';
import { AdminUsersTable, type AdminUserInfo } from './admin-users-table';

export function AdminUsersBlock() {
  const t = useTranslations('AdminUsers');
  const canListUsers = useGlobalPermission({ user: ['list'] });

  const [users, setUsers] = useState<AdminUserInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  // Dialog & Action States
  const [banUser, setBanUser] = useState<AdminUserInfo | null>(null);
  const [banReason, setBanReason] = useState('');
  const [isBanning, setIsBanning] = useState(false);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionUserId, setActionUserId] = useState<string | null>(null);

  // Concurrency & race-condition prevention refs
  const activeControllerRef = useRef<AbortController | null>(null);
  const requestGenRef = useRef(0);
  const searchQueryRef = useRef(searchQuery);

  useEffect(() => {
    searchQueryRef.current = searchQuery;
  }, [searchQuery]);

  const loadUsers = useCallback(async (queryOverride?: string) => {
    // 1. Cancel any active in-flight request
    if (activeControllerRef.current) {
      activeControllerRef.current.abort();
    }

    // 2. Spawn new AbortController and track request generation
    const controller = new AbortController();
    activeControllerRef.current = controller;
    const currentGen = ++requestGenRef.current;

    const targetQuery = queryOverride !== undefined ? queryOverride : searchQueryRef.current;

    setIsLoading(true);
    setLoadError(null);

    try {
      const res = await authClient.admin.listUsers({
        query: {
          limit: 100,
          searchValue: targetQuery || undefined,
        },
        fetchOptions: { signal: controller.signal },
      });

      // Stale or superseded requests MUST NOT mutate state
      if (controller.signal.aborted || currentGen !== requestGenRef.current) {
        return;
      }

      if (res.data?.users) {
        setUsers(res.data.users as unknown as AdminUserInfo[]);
      } else if (res.error) {
        setLoadError(res.error.message || t('errors.load'));
      }
    } catch (err) {
      // Stale or superseded requests MUST NOT mutate error state
      if (controller.signal.aborted || currentGen !== requestGenRef.current) {
        return;
      }
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      setLoadError(t('errors.load'));
    } finally {
      // Stale or superseded requests MUST NOT clear the loading indicator for newer requests
      if (!controller.signal.aborted && currentGen === requestGenRef.current) {
        setIsLoading(false);
      }
    }
  }, [t]);

  useEffect(() => {
    if (!canListUsers) return;

    const timer = setTimeout(() => {
      void loadUsers(searchQuery);
    }, 300);

    return () => {
      clearTimeout(timer);
    };
  }, [canListUsers, loadUsers, searchQuery]);

  useEffect(() => {
    return () => {
      activeControllerRef.current?.abort();
    };
  }, []);

  const handleRoleChange = async (userId: string, newRole: AssignableGlobalRoleName) => {
    if (!isAssignableGlobalRoleName(newRole)) return;

    setActionUserId(userId);
    setActionError(null);
    try {
      const res = await authClient.admin.setRole({
        userId,
        role: newRole,
      });
      if (res?.error) {
        setActionError(res.error.message || t('errors.role'));
        return;
      }
      await loadUsers();
    } catch {
      setActionError(t('errors.role'));
    } finally {
      setActionUserId(null);
    }
  };

  const handleConfirmBan = async () => {
    if (!banUser) return;
    setIsBanning(true);
    setActionError(null);
    try {
      const res = await authClient.admin.banUser({
        userId: banUser.id,
        banReason: banReason || 'Administrative ban',
      });
      if (res?.error) {
        setActionError(res.error.message || t('errors.ban'));
        return;
      }
      setBanUser(null);
      setBanReason('');
      await loadUsers();
    } catch {
      setActionError(t('errors.ban'));
    } finally {
      setIsBanning(false);
    }
  };

  const handleUnban = async (userId: string) => {
    setActionUserId(userId);
    setActionError(null);
    try {
      const res = await authClient.admin.unbanUser({ userId });
      if (res?.error) {
        setActionError(res.error.message || t('errors.unban'));
        return;
      }
      await loadUsers();
    } catch {
      setActionError(t('errors.unban'));
    } finally {
      setActionUserId(null);
    }
  };

  const handleDeactivate = async (userId: string) => {
    setActionUserId(userId);
    setActionError(null);
    try {
      await deactivateUserAccount(userId);
      await loadUsers();
    } catch {
      setActionError(t('errors.deactivate'));
    } finally {
      setActionUserId(null);
    }
  };

  const handleRestore = async (userId: string) => {
    setActionUserId(userId);
    setActionError(null);
    try {
      await restoreUserAccount(userId);
      await loadUsers();
    } catch {
      setActionError(t('errors.restore'));
    } finally {
      setActionUserId(null);
    }
  };

  const handleImpersonate = async (userId: string) => {
    setActionUserId(userId);
    setActionError(null);
    try {
      const res = await authClient.admin.impersonateUser({ userId });
      if (res?.error) {
        setActionError(res.error.message || t('errors.impersonate'));
        return;
      }
      window.location.reload();
    } catch {
      setActionError(t('errors.impersonate'));
    } finally {
      setActionUserId(null);
    }
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

      {/* Search & Filter Header */}
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
          <RefreshCw className={`size-3.5 ${isLoading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* User Table / States */}
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
          onUnban={(userId) => void handleUnban(userId)}
          onDeactivate={(userId) => void handleDeactivate(userId)}
          onRestore={(userId) => void handleRestore(userId)}
          onImpersonate={(userId) => void handleImpersonate(userId)}
        />
      )}

      {/* Ban Reason Dialog */}
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
