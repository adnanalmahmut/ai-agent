import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@repo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'use-intl';

import { useGlobalPermission } from '@/features/authorization/use-permissions';
import {
  type ApiErrorDetails,
  type FeatureFlagState,
  clearFeatureFlag,
  listFeatureFlags,
  setFeatureFlag,
} from '@/lib/application-api';

import {
  type ControlPlaneErrorKind,
  classifyControlPlaneError,
  controlPlaneErrorDetails,
} from './control-plane-errors';
import { PanelState } from './panel-state';

const FEATURE_FLAGS_KEY = ['control-plane', 'feature-flags'] as const;

/** The two writes a row offers, told apart by the value passed to `mutate`. */
type FlagWrite = { kind: 'set'; enabled: boolean } | { kind: 'clear' };

type ActionFailure = {
  kind: ControlPlaneErrorKind;
  details: ApiErrorDetails;
} | null;

export function FeatureFlagsPanel() {
  const t = useTranslations('ControlPlane');
  const canWrite = useGlobalPermission({ controlPlane: ['write'] });

  const flags = useQuery({
    queryKey: FEATURE_FLAGS_KEY,
    // The signal is TanStack's, not ours: reading it here is what lets an
    // abandoned listing be cancelled when the panel unmounts.
    queryFn: ({ signal }) => listFeatureFlags(signal),
  });

  /*
   * Which write failure the panel is currently showing, and whether the
   * operator has dismissed it. That is presentation, not server state: the
   * response it describes was never cached and nothing refetches it.
   */
  const [actionFailure, setActionFailure] = useState<ActionFailure>(null);

  const rows = flags.data ?? [];

  return (
    <PanelState
      isLoading={flags.isFetching && flags.data === undefined}
      loadError={
        flags.error === null ? null : classifyControlPlaneError(flags.error)
      }
      onRetry={() => void flags.refetch()}
      actionError={actionFailure?.kind ?? null}
      actionErrorDetails={actionFailure?.details ?? {}}
      onDismissActionError={() => setActionFailure(null)}
      isEmpty={rows.length === 0}
      emptyLabel={t('flags.empty')}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('flags.column.flag')}</TableHead>
            <TableHead>{t('flags.column.state')}</TableHead>
            <TableHead>{t('flags.column.source')}</TableHead>
            <TableHead className="text-end">
              {t('flags.column.actions')}
            </TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {rows.map((flag) => (
            <FeatureFlagRow
              key={flag.key}
              flag={flag}
              canWrite={canWrite}
              onFailureChange={setActionFailure}
            />
          ))}
        </TableBody>
      </Table>
    </PanelState>
  );
}

/**
 * One row owns one mutation, which is what keeps a write to one flag from
 * disabling every other row: the pending state belongs to the row that is
 * being written and to nothing else.
 */
function FeatureFlagRow({
  flag,
  canWrite,
  onFailureChange,
}: {
  flag: FeatureFlagState;
  canWrite: boolean;
  onFailureChange: (failure: ActionFailure) => void;
}) {
  const t = useTranslations('ControlPlane');
  const queryClient = useQueryClient();

  const write = useMutation({
    /*
     * Same flag, one at a time. The buttons below are already disabled while
     * the row is pending, so a second write is not reachable by clicking; the
     * scope makes the ordering a property of the mutation rather than of how
     * fast React re-renders a disabled button.
     */
    scope: { id: `control-plane-feature-flag:${flag.key}` },
    mutationFn: (intent: FlagWrite) =>
      intent.kind === 'set'
        ? setFeatureFlag(flag.key, intent.enabled)
        : clearFeatureFlag(flag.key),
    onMutate: () => onFailureChange(null),
    onSuccess: (updated) => {
      // The server returned the authoritative row, so the cache takes it
      // instead of asking again. Read through the updater rather than a
      // captured snapshot: another row may have been written meanwhile.
      queryClient.setQueryData<FeatureFlagState[]>(
        FEATURE_FLAGS_KEY,
        (current) =>
          current?.map((row) => (row.key === flag.key ? updated : row)),
      );
    },
    onError: (thrown) =>
      onFailureChange({
        kind: classifyControlPlaneError(thrown),
        details: controlPlaneErrorDetails(thrown),
      }),
  });

  const isPending = write.isPending;
  const hasOverride = flag.platformOverride !== undefined;

  return (
    <TableRow>
      <TableCell className="align-top">
        <div className="font-mono text-xs">{flag.key}</div>
        <p className="mt-1 max-w-md text-xs text-muted-foreground">
          {flag.description}
        </p>
      </TableCell>

      <TableCell className="align-top">
        <Badge variant={flag.enabled ? 'default' : 'secondary'}>
          {flag.enabled ? t('flags.on') : t('flags.off')}
        </Badge>
      </TableCell>

      <TableCell className="align-top text-xs text-muted-foreground">
        {t(`flags.source.${flag.source}`)}
        {flag.source === 'default' ? (
          <span className="block">
            {flag.defaultEnabled ? t('flags.defaultOn') : t('flags.defaultOff')}
          </span>
        ) : null}
      </TableCell>

      <TableCell className="align-top">
        <div className="flex flex-wrap justify-end gap-2">
          {isPending ? (
            <Loader2
              aria-hidden
              className="size-4 animate-spin text-muted-foreground"
            />
          ) : null}

          <Button
            size="sm"
            variant={flag.enabled ? 'outline' : 'default'}
            disabled={!canWrite || isPending}
            onClick={() => write.mutate({ kind: 'set', enabled: !flag.enabled })}
          >
            {flag.enabled ? t('flags.disable') : t('flags.enable')}
          </Button>

          <Button
            size="sm"
            variant="ghost"
            disabled={!canWrite || isPending || !hasOverride}
            onClick={() => write.mutate({ kind: 'clear' })}
          >
            {t('flags.clear')}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}
