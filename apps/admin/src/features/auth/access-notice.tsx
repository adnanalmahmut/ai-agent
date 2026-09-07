import {
  Alert,
  AlertDescription,
  AlertTitle,
  Card,
  CardContent,
} from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import { LanguageSwitcher } from '@/components/language-switcher';

import { SignOutButton } from './sign-out-button';

/**
 * What somebody sees when they are signed in and this workspace is not for
 * them, and what they see when their access could not be established at all.
 *
 * Neither variant names a permission, a role or a staff list. The reader
 * learns that they have no access, not what they would need to have it.
 */
export async function ForbiddenNotice() {
  const t = await getTranslations('forbidden');

  return (
    <AccessCard title={t('title')} description={t('description')}>
      <SignOutButton label={t('signOut')} />
    </AccessCard>
  );
}

export async function UnavailableNotice() {
  const t = await getTranslations('unavailable');

  return <AccessCard title={t('title')} description={t('description')} />;
}

function AccessCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-md flex-col justify-center gap-6 p-6">
      <Card>
        <CardContent className="flex flex-col gap-4">
          <Alert>
            <AlertTitle>{title}</AlertTitle>
            <AlertDescription>{description}</AlertDescription>
          </Alert>
          {children}
        </CardContent>
      </Card>
      <div className="flex justify-center">
        <LanguageSwitcher />
      </div>
    </main>
  );
}
