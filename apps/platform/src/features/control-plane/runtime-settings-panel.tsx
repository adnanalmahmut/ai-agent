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
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'use-intl';

import { useGlobalPermission } from '@/features/authorization/use-permissions';
import {
  type RuntimeSettingState,
  listRuntimeSettings,
  resetRuntimeSetting,
  setRuntimeSetting,
} from '@/lib/application-api';

import { PanelState } from './panel-state';
import { useControlPlaneResource } from './use-control-plane-resource';

/**
 * Parses what the operator typed, without deciding whether it is allowed.
 *
 * The registry's Zod schema is the only authority on bounds, and duplicating
 * one here would be a second opinion that drifts — the client would refuse a
 * value the server accepts, or worse, the reverse. So this converts the string
 * to the JSON type the stored value has and nothing more; the server answers
 * whether it is in range, and its reasons are what the operator reads.
 */
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

  /**
   * The module function is passed directly. It is already stable, so wrapping
   * it in `useCallback` would add a dependency array to keep correct for no
   * gain — and the hook reloads on identity change.
   */
  const resource =
    useControlPlaneResource<RuntimeSettingState>(listRuntimeSettings);

  /** Only the row being edited holds a draft; everything else shows the server's value. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const draftFor = (setting: RuntimeSettingState) =>
    drafts[setting.key] ?? String(setting.value);

  const clearDraft = (key: string) =>
    setDrafts((current) => {
      const next = { ...current };
      delete next[key];

      return next;
    });

  const submit = async (setting: RuntimeSettingState) => {
    const raw = draftFor(setting);

    const succeeded = await resource.mutate(setting.key, () =>
      setRuntimeSetting(setting.key, parseInput(raw, setting.value)),
    );

    /**
     * Kept when the server refuses it. A bounded integer the operator typed is
     * the thing they now have to correct, and snapping the field back to the
     * stored value leaves them nothing to correct — especially beside a
     * message explaining what was wrong with a number they can no longer see.
     * The credentials panel does the opposite, deliberately: a rejected
     * credential is not a value worth preserving.
     */
    if (succeeded) clearDraft(setting.key);
  };

  /**
   * Reset discards the draft too. Without it the row renders "Using the
   * default" and "Default: 12" beside an input still showing the abandoned
   * `99`, which reads as though the setting is 99 — and a later Save would
   * make it so.
   */
  const reset = async (setting: RuntimeSettingState) => {
    const succeeded = await resource.mutate(setting.key, () =>
      resetRuntimeSetting(setting.key),
    );

    // On success only, for the same reason Save keeps a refused value: a reset
    // the server refused has changed nothing, and discarding the operator's
    // text as though it had leaves them an error message and an empty field.
    if (succeeded) clearDraft(setting.key);
  };

  return (
    <PanelState resource={resource} emptyLabel={t('settings.empty')}>
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
          {resource.items.map((setting) => {
            const isPending = resource.isPending(setting.key);
            const editable = canWrite && setting.editable;

            return (
              <TableRow key={setting.key}>
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
                     * The state that needs saying out loud: a row exists and is
                     * being ignored because it no longer satisfies its schema.
                     * Without this the screen shows the default beside the date
                     * the operator set something else, and reset appears to do
                     * nothing at all.
                     */}
                    {setting.storedValueRejected ? (
                      <Badge variant="destructive">
                        {t('settings.rejected')}
                      </Badge>
                    ) : null}

                    {setting.editable ? null : (
                      <Badge variant="outline">
                        {t('settings.deploymentOnly')}
                      </Badge>
                    )}
                  </div>
                </TableCell>

                <TableCell className="align-top">
                  <Input
                    aria-label={setting.key}
                    className="max-w-40"
                    value={draftFor(setting)}
                    disabled={!editable || isPending}
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [setting.key]: event.target.value,
                      }))
                    }
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('settings.defaultIs', {
                      value: String(setting.defaultValue),
                    })}
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
                      onClick={() => void submit(setting)}
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
                      onClick={() => void reset(setting)}
                    >
                      {t('settings.reset')}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </PanelState>
  );
}
