import { useFormatter, useTranslations } from 'use-intl';

/**
 * Displays an organization role in the reader's language.
 *
 * This is presentation of a value the server sent, not a role check — nothing
 * branches on what it says. The distinction matters because "never compare
 * roles in components" is easy to misread as "never mention them".
 *
 * Better Auth stores a role as a comma-separated list, so the value is split
 * before it is translated, and joined with `Intl.ListFormat` through
 * next-intl's formatter rather than with a hard-coded comma — the separator
 * and the conjunction differ between Arabic and English.
 *
 * An unrecognised role falls back to the raw string. A role the server knows
 * about and this application does not is a real possibility after a backend
 * change, and showing it plainly beats throwing on a missing message.
 */
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
