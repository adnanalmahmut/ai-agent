import {
  Button,
  Card,
  CardContent,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@repo/ui';
import { Loader2, RefreshCw, ShieldAlert } from 'lucide-react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'use-intl';

import {
  ApiError,
  ApiUnavailableError,
  CONTROL_PLANE_AUDIT_ACTIONS,
  listControlPlaneAudit,
} from '@/lib/application-api';

import { displayableKeyVersion, recordsKeyVersion } from './audit-state';

type LoadFailure = 'unavailable' | 'unauthenticated' | 'forbidden' | 'failed';

function stateSummary(state: unknown, t: ReturnType<typeof useTranslations>) {
  if (state === null) return t('audit.state.none');
  if (typeof state !== 'object' || state === null)
    return t('audit.state.changed');

  const value = state as Record<string, unknown>;

  if (
    value.kind === 'featureFlagOverride' &&
    typeof value.enabled === 'boolean'
  ) {
    return value.enabled ? t('audit.state.enabled') : t('audit.state.disabled');
  }

  if (value.kind === 'runtimeSettingValue') {
    return value.redacted === true
      ? t('audit.state.redacted')
      : t('audit.state.settingChanged');
  }

  if (value.kind === 'managedSecretSlot') {
    if (value.configured !== true) return t('audit.state.notConfigured');

    const keyVersion = displayableKeyVersion(value.keyVersion);

    if (keyVersion !== null) {
      return t('audit.state.configuredWithKey', { keyVersion });
    }

    // A recorded version this build will not display is said out loud rather
    // than hidden behind the ordinary label, so "no version recorded" and "a
    // version that failed the gate" do not read identically to an operator.
    return recordsKeyVersion(value.keyVersion)
      ? t('audit.state.configuredKeyHidden')
      : t('audit.state.configured');
  }

  return t('audit.state.changed');
}

const KNOWN_ACTIONS: ReadonlySet<string> = new Set(CONTROL_PLANE_AUDIT_ACTIONS);

function actionLabel(
  action: string,
  t: ReturnType<typeof useTranslations>,
): string {
  if (!KNOWN_ACTIONS.has(action)) return t('audit.action.unknown');

  return t(`audit.action.${action}`);
}

function occurredAtLabel(
  occurredAt: string,
  formatter: Intl.DateTimeFormat,
): string {
  const date = new Date(occurredAt);

  return Number.isNaN(date.getTime()) ? '—' : formatter.format(date);
}

function failureOf(error: unknown): LoadFailure {
  if (error instanceof ApiUnavailableError) return 'unavailable';
  if (error instanceof ApiError && error.status === 401)
    return 'unauthenticated';
  if (error instanceof ApiError && error.status === 403) return 'forbidden';
  return 'failed';
}

export function AuditPanel() {
  const t = useTranslations('ControlPlane');
  const locale = useLocale();
  const queryClient = useQueryClient();
  const queryKey = ['control-plane', 'audit'] as const;
  const audit = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      listControlPlaneAudit({ cursor: pageParam, signal }),
    getNextPageParam: (page) => page.nextCursor,
  });
  const items = audit.data?.pages.flatMap((page) => page.items) ?? [];
  const loading = audit.isFetching && !audit.isFetchingNextPage;
  const loadingMore = audit.isFetchingNextPage;
  const failure = audit.error === null ? null : failureOf(audit.error);
  const formatter = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 aria-hidden className="size-4 animate-spin" />
        {t('loading')}
      </div>
    );
  }

  if (failure !== null) {
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-3 py-8">
          <div className="flex items-center gap-2 text-sm">
            <ShieldAlert aria-hidden className="size-4 text-destructive" />
            {t(`error.${failure}`)}
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              // Audit retry starts again at the first page, as before.
              void queryClient.resetQueries({ queryKey, exact: true });
            }}
          >
            <RefreshCw aria-hidden className="size-4" />
            {t('retry')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (items.length === 0) {
    return (
      <p className="py-8 text-sm text-muted-foreground">{t('audit.empty')}</p>
    );
  }

  return (
    <div className="space-y-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('audit.column.when')}</TableHead>
            <TableHead>{t('audit.column.actor')}</TableHead>
            <TableHead>{t('audit.column.action')}</TableHead>
            <TableHead>{t('audit.column.resource')}</TableHead>
            <TableHead>{t('audit.column.scope')}</TableHead>
            <TableHead>{t('audit.column.change')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((event) => (
            <TableRow key={event.id}>
              <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                <time dateTime={event.occurredAt}>
                  {occurredAtLabel(event.occurredAt, formatter)}
                </time>
              </TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {event.actorUserId ?? t('audit.systemActor')}
              </TableCell>
              <TableCell className="text-sm">
                {actionLabel(event.action, t)}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {event.resourceKey}
              </TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {event.organizationId ?? t('audit.platformScope')}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {stateSummary(event.before, t)} → {stateSummary(event.after, t)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {audit.hasNextPage ? (
        <Button
          size="sm"
          variant="outline"
          disabled={loadingMore}
          onClick={() => void audit.fetchNextPage({ cancelRefetch: false })}
        >
          {loadingMore ? (
            <Loader2 aria-hidden className="size-4 animate-spin" />
          ) : null}
          {t('audit.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}
