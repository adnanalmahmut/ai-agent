import {
  Badge,
  Button,
  Input,
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
  NO_ERROR_DETAILS,
  type ApiErrorDetails,
  type RuntimeSettingState,
  listRuntimeSettings,
  resetRuntimeSetting,
  setRuntimeSetting,
} from '@/lib/application-api';

import {
  type ControlPlaneErrorKind,
  classifyControlPlaneError,
  controlPlaneErrorDetails,
} from './control-plane-errors';
import { PanelState } from './panel-state';

const RUNTIME_SETTINGS_KEY = ['control-plane', 'runtime-settings'] as const;

/** The two writes a row offers, told apart by the value passed to `mutate`. */
type SettingWrite = { kind: 'set'; value: unknown } | { kind: 'reset' };

type ActionFailure = {
  kind: ControlPlaneErrorKind;
  details: ApiErrorDetails;
} | null;

function parseInput(raw: string, current: unknown): unknown {
  if (typeof current === 'number') {
    const parsed = Number(raw);

    return raw.trim() === '' || Number.isNaN(parsed) ? raw : parsed;
  }

  /*
   * Only the two exact literals convert. `raw === 'true'` would turn `True`,
   * `1`, and `yes` into `false` — which `z.boolean()` accepts — so an operator
   * who meant to switch a safety control on would be told it saved while it
   * was set to off. Anything else is passed through as a string so the server
   * refuses it and says why.
   */
  if (typeof current === 'boolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;

    return raw;
  }

  return raw;
}

export function RuntimeSettingsPanel() {
  const t = useTranslations('ControlPlane');
  const canWrite = useGlobalPermission({ controlPlane: ['write'] });

  const settings = useQuery({
    queryKey: RUNTIME_SETTINGS_KEY,
    // TanStack's signal, forwarded rather than reproduced: reading it here is
    // what cancels an abandoned listing when the panel unmounts.
    queryFn: ({ signal }) => listRuntimeSettings(signal),
  });

  /*
   * Which write failure the panel is currently showing, and whether the
   * operator has dismissed it. Presentation, not server state.
   */
  const [actionFailure, setActionFailure] = useState<ActionFailure>(null);

  const rows = settings.data ?? [];

  return (
    <PanelState
      isLoading={settings.isFetching && settings.data === undefined}
      loadError={
        settings.error === null
          ? null
          : classifyControlPlaneError(settings.error)
      }
      onRetry={() => void settings.refetch()}
      actionError={actionFailure?.kind ?? null}
      actionErrorDetails={actionFailure?.details ?? NO_ERROR_DETAILS}
      onDismissActionError={() => setActionFailure(null)}
      isEmpty={rows.length === 0}
      emptyLabel={t('settings.empty')}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('settings.column.setting')}</TableHead>
            <TableHead>{t('settings.column.value')}</TableHead>
            <TableHead className="text-end">
              {t('settings.column.actions')}
            </TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {rows.map((setting) => (
            <RuntimeSettingRow
              key={setting.key}
              setting={setting}
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
 * One row owns its draft and its mutation together, which is what makes the
 * two opposite outcomes local decisions rather than coordinated ones: a saved
 * value clears the field, a refused one stays in it to be corrected. The
 * pending lock is this row's own, so writing one setting leaves every other
 * row usable.
 */
function RuntimeSettingRow({
  setting,
  canWrite,
  onFailureChange,
}: {
  setting: RuntimeSettingState;
  canWrite: boolean;
  onFailureChange: (failure: ActionFailure) => void;
}) {
  const t = useTranslations('ControlPlane');
  const queryClient = useQueryClient();

  /** The operator's unsaved text, or null when the field shows the server. */
  const [draft, setDraft] = useState<string | null>(null);

  const write = useMutation({
    /*
     * Same setting, one at a time. The row is already locked while a write is
     * pending, so a second write is not reachable by clicking; the scope makes
     * the ordering a property of the mutation rather than of how fast React
     * re-renders a disabled button.
     */
    scope: { id: `control-plane-runtime-setting:${setting.key}` },
    mutationFn: (intent: SettingWrite) =>
      intent.kind === 'set'
        ? setRuntimeSetting(setting.key, intent.value)
        : resetRuntimeSetting(setting.key),
    onMutate: () => onFailureChange(null),
    onSuccess: (updated) => {
      // The server returned the authoritative row, so the cache takes it
      // instead of asking again. Read through the updater rather than a
      // captured snapshot: another row may have been written meanwhile.
      queryClient.setQueryData<RuntimeSettingState[]>(
        RUNTIME_SETTINGS_KEY,
        (current) =>
          current?.map((row) => (row.key === setting.key ? updated : row)),
      );

      // Only once the write landed. A value the server refused has changed
      // nothing, and discarding the operator's text as though it had leaves
      // them an error message and a field they have to retype.
      setDraft(null);
    },
    onError: (thrown) =>
      onFailureChange({
        kind: classifyControlPlaneError(thrown),
        details: controlPlaneErrorDetails(thrown),
      }),
  });

  const value = draft ?? String(setting.value);
  const isPending = write.isPending;
  const editable = canWrite && setting.editable;

  return (
    <TableRow>
      <TableCell className="align-top">
        <div className="font-mono text-xs">{setting.key}</div>
        <p className="mt-1 max-w-md text-xs text-muted-foreground">
          {setting.description}
        </p>

        <div className="mt-2 flex flex-wrap gap-2">
          {setting.isDefault ? (
            <Badge variant="secondary">{t('settings.default')}</Badge>
          ) : null}

          {/*
           * The state that needs saying out loud: a row exists and is being
           * ignored because it no longer satisfies its schema. Without this
           * the screen shows the default beside the date the operator set
           * something else, and reset appears to do nothing at all.
           */}
          {setting.storedValueRejected ? (
            <Badge variant="destructive">{t('settings.rejected')}</Badge>
          ) : null}

          {setting.editable ? null : (
            <Badge variant="outline">{t('settings.deploymentOnly')}</Badge>
          )}
        </div>
      </TableCell>

      <TableCell className="align-top">
        <Input
          aria-label={setting.key}
          className="max-w-40"
          value={value}
          disabled={!editable || isPending}
          onChange={(event) => setDraft(event.target.value)}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          {t('settings.defaultIs', { value: String(setting.defaultValue) })}
        </p>
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
            disabled={!editable || isPending}
            onClick={() =>
              write.mutate({
                kind: 'set',
                value: parseInput(value, setting.value),
              })
            }
          >
            {t('settings.save')}
          </Button>

          <Button
            size="sm"
            variant="ghost"
            disabled={
              !editable ||
              isPending ||
              (setting.isDefault && !setting.storedValueRejected)
            }
            onClick={() => write.mutate({ kind: 'reset' })}
          >
            {t('settings.reset')}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}
