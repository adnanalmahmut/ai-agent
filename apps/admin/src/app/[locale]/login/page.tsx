import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@repo/ui';
import { isAppLocale } from '@repo/i18n-core';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { LanguageSwitcher } from '@/components/language-switcher';
import { resolveAdminAccess } from '@/features/auth/admin-access';
import { ADMIN_ROUTES } from '@/features/auth/routes';
import { SignInForm } from '@/features/auth/sign-in-form';
import { redirect } from '@/i18n/server-navigation';

/**
 * Somebody who already has a session is sent to the workspace rather than
 * being asked to sign in again. Whether that session is a staff session is
 * the workspace's decision, taken in one place; this page does not
 * second-guess it.
 */
export default async function LoginPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const [{ locale }, access, t] = await Promise.all([
    params,
    resolveAdminAccess(),
    getTranslations('signIn'),
  ]);
  if (!isAppLocale(locale)) notFound();

  if (access.kind === 'granted' || access.kind === 'denied') {
    return redirect({ href: ADMIN_ROUTES.workspace, locale });
  }

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-md flex-col justify-center gap-6 p-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <SignInForm />
        </CardContent>
      </Card>
      <div className="flex justify-center">
        <LanguageSwitcher />
      </div>
    </main>
  );
}
