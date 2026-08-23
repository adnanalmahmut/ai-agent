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
import { useFormatter, useTranslations } from 'use-intl';

import { useGlobalPermission } from '@/features/authorization/use-permissions';
import {
  type ManagedSecretDescription,
  listManagedSecrets,
  removeManagedSecret,
  setManagedSecret,
} from '@/lib/application-api';

import { PanelState } from './panel-state';
import { useControlPlaneResource } from './use-control-plane-resource';

/**
 * Provider credentials, which this screen can write and can never read.
 *
 * There is no endpoint that returns a stored secret and no masked preview of
 * one — the first four characters of an API key are a real substring of a real
 * credential, and recognising it is not worth putting any of it on a screen.
 * So the only evidence a credential exists is the metadata beside it: whether
 * a slot is configured, when it was last rotated, and whether it still
 * decrypts.
 *
 * The input is `type="password"` and, more importantly, is cleared the moment
 * the write returns — on failure as well as on success, because a rejected
 * value is still a credential. React mirrors a controlled input's value into
 * the serialized DOM, so anything that reads `outerHTML` sees whatever is
 * still in the field; the unconditional clear is what bounds that window, and
 * it must not become conditional.
 */
export function ManagedSecretsPanel() {
  const t = useTranslations('ControlPlane');
  const format = useFormatter();
  const canWrite = useGlobalPermission({ managedSecret: ['write'] });

  /**
   * The module function is passed directly. It is already stable, so wrapping
   * it in `useCallback` would add a dependency array to keep correct for no
   * gain — and the hook reloads on identity change.
   */
  const resource =
    useControlPlaneResource<ManagedSecretDescription>(listManagedSecrets);

  const [values, setValues] = useState<Record<string, string>>({});
  const [labels, setLabels] = useState<Record<string, string>>({});

  const clearDraft = (key: string) => {
    setValues((current) => {
      const next = { ...current };
      delete next[key];

      return next;
    });
    setLabels((current) => {
      const next = { ...current };
      delete next[key];

      return next;
    });
  };

  /**
   * Rows whose label was refused for holding the credential.
   *
   * Local rather than an `actionError`, because it is not the server's answer
   * and the operator has not sent anything yet — the point is that nothing was
   * sent.
   */
  const [labelRefused, setLabelRefused] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const submit = async (secret: ManagedSecretDescription) => {
    const value = values[secret.key] ?? '';
    const label = labels[secret.key]?.trim();

    /**
     * The label is the one field on this screen that is stored in plaintext
     * and read back verbatim, and it sits directly under a masked field in the
     * same narrow column — so a paste that lands one input too low is silent,
     * and the operator's correction leaves the credential behind in the note.
     * Sending it would put a live credential in a column AES-256-GCM never
     * touches, where it would also reach every backup and every listing.
     */
    if (value !== '' && label !== undefined && label.includes(value)) {
      setLabelRefused((keys) => new Set(keys).add(secret.key));

      return;
    }

    setLabelRefused((keys) => {
      const next = new Set(keys);
      next.delete(secret.key);

      return next;
    });

    await resource.mutate(secret.key, () =>
      setManagedSecret(
        secret.key,
        value,
        label === undefined || label === '' ? undefined : label,
      ),
    );

    // Unconditionally, including after a failure: a rejected value is still a
    // credential, and leaving it in the field is leaving it on the screen.
    clearDraft(secret.key);
  };

  return (
    <PanelState resource={resource} emptyLabel={t('secrets.empty')}>
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
          {resource.items.map((secret) => {
            const isPending = resource.isPending(secret.key);
            const draft = values[secret.key] ?? '';

            return (
              <TableRow key={secret.key}>
                <TableCell className="align-top">
                  <div className="font-mono text-xs">{secret.key}</div>
                  <p className="mt-1 max-w-md text-xs text-muted-foreground">
                    {secret.description}
                  </p>
                </TableCell>

                <TableCell className="align-top">
                  <div className="flex flex-col items-start gap-1">
                    <Badge
                      variant={secret.configured ? 'default' : 'secondary'}
                    >
                      {secret.configured
                        ? t('secrets.configured')
                        : t('secrets.notConfigured')}
                    </Badge>

                    {/*
                     * "Configured but unusable" is the case worth surfacing: the
                     * row was sealed under a different master key, so the next
                     * provider call fails. Told here it is a re-entry; found at
                     * runtime it is an unexplained outage.
                     */}
                    {secret.configured && !secret.usable ? (
                      <Badge variant="destructive">
                        {t('secrets.unusable')}
                      </Badge>
                    ) : null}

                    {secret.label !== undefined ? (
                      <span className="text-xs text-muted-foreground">
                        {secret.label}
                      </span>
                    ) : null}

                    {/*
                      * When it was last rotated is the closest thing to
                      * evidence this screen can offer that the configured
                      * credential is the one the operator thinks it is. It is
                      * the only history available, since nothing records who
                      * changed it.
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
                       * `new-password`, not `off`. Chromium ignores `off` on a
                       * password field — suppressing it is what this token is
                       * for. Two things it prevents: the operator's own
                       * platform password being filled into a provider slot
                       * and then sealed and sent to that provider, and the
                       * provider key being captured into a browser password
                       * manager. It is also what every other password input in
                       * this application already uses.
                       */
                      autoComplete="new-password"
                      aria-label={t('secrets.valueLabel', { key: secret.key })}
                      placeholder={t('secrets.valuePlaceholder')}
                      value={draft}
                      disabled={!canWrite || isPending}
                      onChange={(event) =>
                        setValues((current) => ({
                          ...current,
                          [secret.key]: event.target.value,
                        }))
                      }
                    />
                    <Input
                      /*
                       * Suppressed like the field above it, for the opposite
                       * reason: this one is not a password field, so it is
                       * save-eligible and fill-eligible by default — and it is
                       * the field a misplaced credential lands in.
                       */
                      autoComplete="off"
                      maxLength={120}
                      aria-label={t('secrets.labelLabel', { key: secret.key })}
                      placeholder={
                        secret.label ?? t('secrets.labelPlaceholder')
                      }
                      value={labels[secret.key] ?? ''}
                      disabled={!canWrite || isPending}
                      onChange={(event) =>
                        setLabels((current) => ({
                          ...current,
                          [secret.key]: event.target.value,
                        }))
                      }
                    />

                    {labelRefused.has(secret.key) ? (
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
                      disabled={!canWrite || isPending || draft === ''}
                      onClick={() => void submit(secret)}
                    >
                      {secret.configured
                        ? t('secrets.rotate')
                        : t('secrets.store')}
                    </Button>

                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!canWrite || isPending || !secret.configured}
                      onClick={() =>
                        void resource.mutate(secret.key, () =>
                          removeManagedSecret(secret.key),
                        )
                      }
                    >
                      {t('secrets.remove')}
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
