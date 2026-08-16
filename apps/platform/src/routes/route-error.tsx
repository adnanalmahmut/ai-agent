import { DEFAULT_LOCALE, LOCALE_META } from '@repo/i18n-core';
import {
  Button,
  Card,
  CardContent,
  DirectionProvider,
  buttonVariants,
} from '@repo/ui';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { isRouteErrorResponse, useRouteError } from 'react-router';
import { IntlProvider, useTranslations } from 'use-intl';

import { EmptyState } from '@/components/empty-state';
import { PLATFORM_ROUTES } from '@/features/auth/routes';
import { defaultMessages } from '@/i18n/messages';
import { Link } from '@/i18n/navigation';
import { ApiUnavailableError } from '@/lib/application-api';

/**
 * Error reporting comes in two layers, for one reason: a translated error page
 * needs a dictionary, and the failure being reported might be the dictionary.
 *
 * `RouteError` is the one almost every failure reaches. It sits *inside* the
 * locale route, so it renders in the language the reader chose, with the
 * providers already mounted around it.
 *
 * `RouteErrorBoundary` sits at the root, above the locale route, and exists
 * for the failures underneath it cannot handle — a locale that could not
 * resolve, a dictionary chunk that would not load. It brings its own
 * `IntlProvider` using the dictionary that is always in the bundle, so even
 * that case is a translated page rather than a blank one.
 *
 * Neither shows anything about the thrown value — no message, no stack, no
 * provider internals. An error page is exactly where infrastructure detail
 * leaks to whoever is looking, and none of it would help them.
 */

/** The localized boundary. Rendered inside the reader's own locale route. */
export function RouteError() {
  return <RouteErrorCard />;
}

/** The last-resort boundary, in the default locale, with its own providers. */
export function RouteErrorBoundary() {
  const { direction } = LOCALE_META[DEFAULT_LOCALE];

  return (
    <IntlProvider locale={DEFAULT_LOCALE} messages={defaultMessages}>
      <DirectionProvider direction={direction}>
        <RouteErrorCard />
      </DirectionProvider>
    </IntlProvider>
  );
}

/**
 * Three states, because they have three different remedies.
 *
 * A 404 means the URL is wrong and the dashboard is the way back. An
 * unreachable API means try again shortly — this is what the session read
 * throws, and it is the reason a failed session fetch does not silently
 * present as being signed out. Everything else is unexpected.
 */
function RouteErrorCard() {
  const t = useTranslations('Errors');
  const error = useRouteError();
  const state = classify(error);

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-5 py-16">
      <Card className="w-full max-w-md">
        <CardContent>
          <EmptyState
            icon={<AlertTriangle className="size-5" />}
            title={t(`${state}.title`)}
            description={t(`${state}.description`)}
            className="border-0"
            action={
              state === 'notFound' ? (
                <Link
                  href={PLATFORM_ROUTES.dashboard}
                  className={buttonVariants({ variant: 'outline' })}
                >
                  {t('notFound.action')}
                </Link>
              ) : (
                <Button
                  variant="outline"
                  className="gap-2"
                  // A full reload rather than a revalidation: whatever failed
                  // may have left the router mid-navigation, and the reader
                  // wants a working page, not a partial retry.
                  onClick={() => window.location.reload()}
                >
                  <RotateCcw />
                  {t('unexpected.action')}
                </Button>
              )
            }
          />
        </CardContent>
      </Card>
    </div>
  );
}

function classify(error: unknown): 'notFound' | 'unavailable' | 'unexpected' {
  if (isRouteErrorResponse(error) && error.status === 404) return 'notFound';
  if (error instanceof ApiUnavailableError) return 'unavailable';

  return 'unexpected';
}
