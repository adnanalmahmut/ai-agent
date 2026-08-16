import { createNavigation } from 'next-intl/navigation';

import { routing } from './routing';

/**
 * Locale-aware navigation primitives.
 *
 * Prefer these over `next/link` and `next/navigation` for any route that
 * belongs to the localized tree: they apply the configured prefix mode
 * automatically, so the same code works under both `always` and `as-needed`
 * without a single conditional.
 */
export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);
