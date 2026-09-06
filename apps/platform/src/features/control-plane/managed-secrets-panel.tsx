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
import { useFormatter, useTranslations } from 'use-intl';

import { useGlobalPermission } from '@/features/authorization/use-permissions';
import {
  NO_ERROR_DETAILS,
  type ApiErrorDetails,
  type ManagedSecretDescription,
  listManagedSecrets,
  removeManagedSecret,
  setManagedSecret,
} from '@/lib/application-api';

import {
  type ControlPlaneErrorKind,
  classifyControlPlaneError,
  controlPlaneErrorDetails,
} from './control-plane-errors';
import { PanelState } from './panel-state';

const MANAGED_SECRETS_KEY = ['control-plane', 'managed-secrets'] as const;

/** The two writes a row offers, told apart by the value passed to `mutate`. */
type SecretWrite =
  | { kind: 'set'; value: string; label: string | undefined }
  | { kind: 'remove' };

type ActionFailure = {
  kind: ControlPlaneErrorKind;
  details: ApiErrorDetails;
} | null;

export function ManagedSecretsPanel() {
  const t = useTranslations('ControlPlane');
  const canWrite = useGlobalPermission({ managedSecret: ['write'] });

  const secrets = useQuery({
    queryKey: MANAGED_SECRETS_KEY,
    // TanStack's signal, forwarded rather than reproduced: reading it here is
    // what cancels an abandoned listing when the panel unmounts.
    queryFn: ({ signal }) => listManagedSecrets(signal),
  });

  /*
   * Which write failure the panel is currently showing, and whether the
   * operator has dismissed it. Presentation, not server state.
   */
  const [actionFailure, setActionFailure] = useState<ActionFailure>(null);

  const rows = secrets.data ?? [];

  return (
    <PanelState
      isLoading={secrets.isFetching && secrets.data === undefined}
      loadError={
        secrets.error === null ? null : classifyControlPlaneError(secrets.error)
      }
      onRetry={() => void secrets.refetch()}
      actionError={actionFailure?.kind ?? null}
      actionErrorDetails={actionFailure?.details ?? NO_ERROR_DETAILS}
      onDismissActionError={() => setActionFailure(null)}
      isEmpty={rows.length === 0}
      emptyLabel={t('secrets.empty')}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('secrets.column.secret')}</TableHead>
            <TableHead>{t('secrets.column.status')}</TableHead>
            <TableHead>{t('secrets.column.value')}</TableHead>
            <TableHead className="text-end">
              {t('secrets.column.actions')}
            </TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {rows.map((secret) => (
            <ManagedSecretRow
              key={secret.key}
              secret={secret}
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
 * One row owns its two drafts and its mutation. The credential never reaches
 * the query cache — what the server returns is a description of the slot, not
 * the value in it — and the drafts holding it are cleared the moment the write
 * has been attempted, whichever way it went.
 */
function ManagedSecretRow({
  secret,
  canWrite,
  onFailureChange,
}: {
  secret: ManagedSecretDescription;
  canWrite: boolean;
  onFailureChange: (failure: ActionFailure) => void;
}) {
  const t = useTranslations('ControlPlane');
  const format = useFormatter();
  const queryClient = useQueryClient();

  const [value, setValue] = useState('');
  const [label, setLabel] = useState('');
  const [labelRefused, setLabelRefused] = useState(false);

  const clearDrafts = () => {
    setValue('');
    setLabel('');
  };

  const write = useMutation({
    /*
     * Same credential, one at a time. The row is already locked while a write
     * is pending, so a second write is not reachable by clicking; the scope
     * makes the ordering a property of the mutation rather than of how fast
     * React re-renders a disabled button.
     */
    scope: { id: `control-plane-managed-secret:${secret.key}` },
    mutationFn: (intent: SecretWrite) =>
      intent.kind === 'set'
        ? setManagedSecret(secret.key, intent.value, intent.label)
        : removeManagedSecret(secret.key),
    onMutate: () => onFailureChange(null),
    onSuccess: (updated) => {
      // The server returned the authoritative description of the slot, so the
      // cache takes it instead of asking again. Read through the updater
      // rather than a captured snapshot: another row may have been written
      // meanwhile.
      queryClient.setQueryData<ManagedSecretDescription[]>(
        MANAGED_SECRETS_KEY,
        (current) =>
          current?.map((row) => (row.key === secret.key ? updated : row)),
      );
    },
    onError: (thrown) =>
      onFailureChange({
        kind: classifyControlPlaneError(thrown),
        details: controlPlaneErrorDetails(thrown),
      }),
    /*
     * Unconditionally, including after a refusal: a rejected value is still a
     * credential, and leaving it in the field is leaving it on the screen.
     * `onSettled` is where that has to happen, because it is the one callback
     * both outcomes reach.
     */
    onSettled: (_updated, _thrown, intent) => {
      if (intent.kind === 'set') clearDrafts();
    },
  });

  const submit = () => {
    const trimmedLabel = label.trim();

    if (value !== '' && trimmedLabel.includes(value)) {
      setLabelRefused(true);

      // Deliberately without clearing: nothing was sent, so the operator still
      // has a note to correct rather than a credential to retype.
      return;
    }

    setLabelRefused(false);

    write.mutate({
      kind: 'set',
      value,
      label: trimmedLabel === '' ? undefined : trimmedLabel,
    });
  };

  const isPending = write.isPending;

  return (
    <TableRow>
      <TableCell className="align-top">
        <div className="font-mono text-xs">{secret.key}</div>
        <p className="mt-1 max-w-md text-xs text-muted-foreground">
          {secret.description}
        </p>
      </TableCell>

      <TableCell className="align-top">
        <div className="flex flex-col items-start gap-1">
          <Badge variant={secret.configured ? 'default' : 'secondary'}>
            {secret.configured
              ? t('secrets.configured')
              : t('secrets.notConfigured')}
          </Badge>

          {/*
           * "Configured but unusable" is the case worth surfacing: the row was
           * sealed under a different master key, so the next provider call
           * fails. Told here it is a re-entry; found at runtime it is an
           * unexplained outage.
           */}
          {secret.configured && !secret.usable ? (
            <Badge variant="destructive">{t('secrets.unusable')}</Badge>
          ) : null}

          {secret.label !== undefined ? (
            <span className="text-xs text-muted-foreground">
              {secret.label}
            </span>
          ) : null}

          {/*
           * When it was last rotated is the closest thing to evidence this
           * screen can offer that the configured credential is the one the
           * operator thinks it is. It is the only history available, since
           * nothing records who changed it.
           */}
          {secret.configured && secret.lastRotatedAt !== undefined ? (
            <span className="text-xs text-muted-foreground">
              {t('secrets.lastRotated', {
                when: format.dateTime(new Date(secret.lastRotatedAt), {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }),
              })}
            </span>
          ) : null}
        </div>
      </TableCell>

      <TableCell className="align-top">
        <div className="flex max-w-64 flex-col gap-2">
          <Input
            type="password"
            /*
             * `new-password`, not `off`. Chromium ignores `off` on a password
             * field — suppressing it is what this token is for. Two things it
             * prevents: the operator's own platform password being filled into
             * a provider slot and then sealed and sent to that provider, and
             * the provider key being captured into a browser password manager.
             * It is also what every other password input in this application
             * already uses.
             */
            autoComplete="new-password"
            aria-label={t('secrets.valueLabel', { key: secret.key })}
            placeholder={t('secrets.valuePlaceholder')}
            value={value}
            disabled={!canWrite || isPending}
            onChange={(event) => setValue(event.target.value)}
          />
          <Input
            /*
             * Suppressed like the field above it, for the opposite reason:
             * this one is not a password field, so it is save-eligible and
             * fill-eligible by default — and it is the field a misplaced
             * credential lands in.
             */
            autoComplete="off"
            maxLength={120}
            aria-label={t('secrets.labelLabel', { key: secret.key })}
            placeholder={secret.label ?? t('secrets.labelPlaceholder')}
            value={label}
            disabled={!canWrite || isPending}
            onChange={(event) => setLabel(event.target.value)}
          />

          {labelRefused ? (
            <p className="text-xs text-destructive">
              {t('secrets.labelHoldsCredential')}
            </p>
          ) : null}
        </div>
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
            disabled={!canWrite || isPending || value === ''}
            onClick={submit}
          >
            {secret.configured ? t('secrets.rotate') : t('secrets.store')}
          </Button>

          <Button
            size="sm"
            variant="ghost"
            disabled={!canWrite || isPending || !secret.configured}
            onClick={() => write.mutate({ kind: 'remove' })}
          >
            {t('secrets.remove')}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}
