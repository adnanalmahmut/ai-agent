import { Alert, AlertDescription, Button, Card, CardContent } from '@repo/ui';
import { Loader2, RefreshCw, ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';

import { errorDetailLines, type ApiErrorDetails } from '@/lib/application-api';

import type { ControlPlaneErrorKind } from './control-plane-errors';

/**
 * The shared frame every control-plane panel renders inside: loading, a failed
 * listing with a retry, a dismissible write failure, and the empty case.
 *
 * It takes the states themselves rather than the object that produced them, so
 * a panel backed by TanStack Query and a panel backed by the custom resource
 * hook render the same frame without this component knowing which is which.
 */
export function PanelState({
  isLoading,
  loadError,
  onRetry,
  actionError,
  actionErrorDetails,
  onDismissActionError,
  isEmpty,
  emptyLabel,
  children,
}: {
  isLoading: boolean;
  loadError: ControlPlaneErrorKind | null;
  onRetry: () => void;
  actionError: ControlPlaneErrorKind | null;
  actionErrorDetails: ApiErrorDetails;
  onDismissActionError: () => void;
  isEmpty: boolean;
  emptyLabel: string;
  children: ReactNode;
}) {
  const t = useTranslations('ControlPlane');

  const reasons = errorDetailLines(actionErrorDetails);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 aria-hidden className="size-4 animate-spin" />
        {t('loading')}
      </div>
    );
  }

  if (loadError !== null) {
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-3 py-8">
          <div className="flex items-center gap-2 text-sm">
            <ShieldAlert aria-hidden className="size-4 text-destructive" />
            {t(`error.${loadError}`)}
          </div>

          <Button size="sm" variant="outline" onClick={onRetry}>
            <RefreshCw aria-hidden className="size-4" />
            {t('retry')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {actionError !== null ? (
        <Alert variant="destructive">
          <AlertDescription className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p>{t(`error.${actionError}`)}</p>

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

            <Button size="sm" variant="ghost" onClick={onDismissActionError}>
              {t('dismiss')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {isEmpty ? (
        <p className="py-8 text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        children
      )}
    </div>
  );
}
