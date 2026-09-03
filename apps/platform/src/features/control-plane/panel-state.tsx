import { Alert, AlertDescription, Button, Card, CardContent } from '@repo/ui';
import { Loader2, RefreshCw, ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';

import type { ControlPlaneResource } from './use-control-plane-resource';

export function PanelState<T extends { key: string }>({
  resource,
  emptyLabel,
  children,
}: {
  resource: ControlPlaneResource<T>;
  emptyLabel: string;
  children: ReactNode;
}) {
  const t = useTranslations('ControlPlane');

  const { issues, reason } = resource.actionErrorDetails;
  const reasons = issues ?? (reason === undefined ? [] : [reason]);

  if (resource.isLoading) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 aria-hidden className="size-4 animate-spin" />
        {t('loading')}
      </div>
    );
  }

  if (resource.loadError !== null) {
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-3 py-8">
          <div className="flex items-center gap-2 text-sm">
            <ShieldAlert aria-hidden className="size-4 text-destructive" />
            {t(`error.${resource.loadError}`)}
          </div>

          <Button size="sm" variant="outline" onClick={resource.reload}>
            <RefreshCw aria-hidden className="size-4" />
            {t('retry')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {resource.actionError !== null ? (
        <Alert variant="destructive">
          <AlertDescription className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p>{t(`error.${resource.actionError}`)}</p>

              {/*
               * The server's own reasons, under the generic sentence rather
               * than instead of it. A bounded setting is useless if the
               * screen cannot say why 5000 was refused, and "check the
               * allowed range" is not even the right sentence for a
               * credential that started with the wrong prefix. These
               * describe the rule and never the submitted value, which is
               * what makes them safe to render.
               */}
              {reasons.length > 0 ? (
                <ul className="list-disc space-y-0.5 ps-4 text-xs">
                  {reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              ) : null}
            </div>

            <Button
              size="sm"
              variant="ghost"
              onClick={resource.dismissActionError}
            >
              {t('dismiss')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {resource.items.length === 0 ? (
        <p className="py-8 text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        children
      )}
    </div>
  );
}
