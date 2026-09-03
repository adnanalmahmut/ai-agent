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
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'use-intl';

import { useGlobalPermission } from '@/features/authorization/use-permissions';
import {
  type FeatureFlagState,
  clearFeatureFlag,
  listFeatureFlags,
  setFeatureFlag,
} from '@/lib/application-api';

import { PanelState } from './panel-state';
import { useControlPlaneResource } from './use-control-plane-resource';

export function FeatureFlagsPanel() {
  const t = useTranslations('ControlPlane');
  const canWrite = useGlobalPermission({ controlPlane: ['write'] });

  const resource = useControlPlaneResource<FeatureFlagState>(listFeatureFlags);

  return (
    <PanelState resource={resource} emptyLabel={t('flags.empty')}>
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
          {resource.items.map((flag) => {
            const isPending = resource.isPending(flag.key);
            const hasOverride = flag.platformOverride !== undefined;

            return (
              <TableRow key={flag.key}>
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
                      {flag.defaultEnabled
                        ? t('flags.defaultOn')
                        : t('flags.defaultOff')}
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
                      onClick={() =>
                        void resource.mutate(flag.key, () =>
                          setFeatureFlag(flag.key, !flag.enabled),
                        )
                      }
                    >
                      {flag.enabled ? t('flags.disable') : t('flags.enable')}
                    </Button>

                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!canWrite || isPending || !hasOverride}
                      onClick={() =>
                        void resource.mutate(flag.key, () =>
                          clearFeatureFlag(flag.key),
                        )
                      }
                    >
                      {t('flags.clear')}
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
