import { useFormatter, useTranslations } from 'use-intl';

export function OrganizationRoleLabel({ role }: { role: string }) {
  const t = useTranslations('Organization');
  const format = useFormatter();

  const labels = role
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const key = `roles.${part}` as const;
      return t.has(key) ? t(key) : part;
    });

  if (labels.length === 0) return null;

  return <>{format.list(labels)}</>;
}
