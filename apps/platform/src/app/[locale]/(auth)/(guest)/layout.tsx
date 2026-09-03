import { isAppLocale } from '@repo/i18n-core';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { getServerSession } from '@/features/auth/server-session';
import { redirect } from '@/i18n/server-navigation';

export default async function GuestOnlyLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const [{ locale }, session] = await Promise.all([params, getServerSession()]);
  if (!isAppLocale(locale)) notFound();
  if (session) redirect({ href: '/', locale });
  return children;
}
