'use client';

import { Button, Card, CardContent, CardHeader, CardTitle } from '@repo/ui';
import { useTranslations } from 'next-intl';

export default function ErrorBoundary({ reset }: { reset: () => void }) {
  const t = useTranslations('Errors');

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-5">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>
            <h1>{t('unexpected.title')}</h1>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t('unexpected.description')}
          </p>
          <Button onClick={reset}>{t('unexpected.action')}</Button>
        </CardContent>
      </Card>
    </main>
  );
}
