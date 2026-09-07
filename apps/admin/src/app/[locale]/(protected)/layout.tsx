import { isAppLocale } from '@repo/i18n-core';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import {
  ForbiddenNotice,
  UnavailableNotice,
} from '@/features/auth/access-notice';
import { resolveAdminAccess } from '@/features/auth/admin-access';
import { ADMIN_ROUTES } from '@/features/auth/routes';
import { AdminShell } from '@/features/shell/admin-shell';
import { redirect } from '@/i18n/server-navigation';

/**
 * The gate. Every administrative screen renders inside this layout, so this
 * is the one place that decides whether one may.
 *
 * It runs on the server and `children` is reached on exactly one branch — the
 * one where a staff session was established. Nothing is rendered and then
 * corrected: a refused request never produces protected markup at all, which
 * is what a client-side guard cannot promise.
 *
 * Signed out is a redirect to sign in. Signed in without authority is a
 * refusal in place, because sending that person to a sign-in form would tell
 * them they are signed out when they are not.
 */
export default async function ProtectedLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const [{ locale }, access] = await Promise.all([params, resolveAdminAccess()]);
  if (!isAppLocale(locale)) notFound();

  if (access.kind === 'anonymous') {
    return redirect({ href: ADMIN_ROUTES.signIn, locale });
  }

  if (access.kind === 'unavailable') return <UnavailableNotice />;
  if (access.kind !== 'granted') return <ForbiddenNotice />;

  return <AdminShell>{children}</AdminShell>;
}
