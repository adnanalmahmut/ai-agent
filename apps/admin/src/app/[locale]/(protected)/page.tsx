import { getTranslations } from 'next-intl/server';

export default async function AdminWorkspacePage() {
  const t = await getTranslations('shell');

  return <p className="text-muted-foreground">{t('empty')}</p>;
}
