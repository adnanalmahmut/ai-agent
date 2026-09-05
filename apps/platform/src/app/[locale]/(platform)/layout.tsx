import { isAppLocale } from '@repo/i18n-core';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { PlatformQueryProvider } from '@/components/platform-query-provider';
import { PlatformShell } from '@/features/platform-shell/platform-shell';
import { AUTH_ROUTES, RETURN_TO_PARAM } from '@/features/auth/routes';
import { getServerSession } from '@/features/auth/server-session';
import { returnPathFromUrl } from '@/features/auth/safe-return-url';
import { redirect } from '@/i18n/server-navigation';

export default async function ProtectedLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const [{ locale }, requestHeaders, session] = await Promise.all([
    params,
    headers(),
    getServerSession(),
  ]);
  if (!isAppLocale(locale)) notFound();

  if (!session) {
    const interrupted = new URL(
      requestHeaders.get('x-platform-return-to') ?? '/',
      'https://platform.invalid',
    );
    const returnTo = returnPathFromUrl(interrupted);
    return redirect({
      href:
        returnTo === '/'
          ? AUTH_ROUTES.signIn
          : {
              pathname: AUTH_ROUTES.signIn,
              query: { [RETURN_TO_PARAM]: returnTo },
            },
      locale,
    });
  }

  return (
    <PlatformQueryProvider>
      <PlatformShell session={session}>{children}</PlatformShell>
    </PlatformQueryProvider>
  );
}
