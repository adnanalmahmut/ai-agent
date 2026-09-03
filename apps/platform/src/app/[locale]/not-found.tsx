import { Card, CardContent, CardHeader, CardTitle, buttonVariants } from '@repo/ui';
import { getTranslations } from 'next-intl/server';

import { PLATFORM_ROUTES } from '@/features/auth/routes';
import { Link } from '@/i18n/navigation';

export default async function NotFoundPage() {
  const t = await getTranslations('Errors');

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-5">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>{t('notFound.title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t('notFound.description')}
          </p>
          <Link
            href={PLATFORM_ROUTES.dashboard}
            className={buttonVariants({ variant: 'outline' })}
          >
            {t('notFound.action')}
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}
