import { LOCALE_META, type AppLocale } from '@repo/i18n-core';
import { DirectionProvider } from '@repo/ui';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { IntlProvider } from 'use-intl';

import { PlatformQueryProvider } from '@/components/platform-query-provider';
import type { PlatformSession } from '@/features/auth/session-types';
import { PlatformSessionProvider } from '@/features/auth/use-platform-session';
import {
  OrganizationProvider,
  type OrganizationContext,
} from '@/features/organization/organization-context';
import { stubLocation, testRouter } from '@/test/navigation-stub';

import arabic from '../../messages/ar.json';
import english from '../../messages/en.json';

const MESSAGES = { ar: arabic, en: english } as const;

export const TEST_SESSION = {
  user: {
    id: 'user_owner',
    name: 'Sara Haddad',
    email: 'sara@example.com',
    emailVerified: true,
    image: null,
    role: 'admin',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  },
  session: {
    id: 'session_1',
    token: 'test-token',
    userId: 'user_owner',
    expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  },
} as PlatformSession;

export function renderWithProviders(
  ui: ReactElement,
  {
    locale = 'en' as AppLocale,
    organization,
    session = TEST_SESSION,
  }: {
    locale?: AppLocale;
    organization?: OrganizationContext;
    session?: PlatformSession;
  } = {},
): RenderResult & { locale: AppLocale } {
  const { direction } = LOCALE_META[locale];
  const content = organization ? (
    <OrganizationProvider value={organization}>{ui}</OrganizationProvider>
  ) : (
    ui
  );

  // Mirrors the protected layout: one query client per mounted tree, so no
  // server state survives from one test into the next.
  const result = render(
    <IntlProvider locale={locale} messages={MESSAGES[locale]} timeZone="UTC">
      <DirectionProvider direction={direction}>
        <PlatformQueryProvider>
          <PlatformSessionProvider session={session}>
            {content}
          </PlatformSessionProvider>
        </PlatformQueryProvider>
      </DirectionProvider>
    </IntlProvider>,
  );

  return Object.assign(result, { locale });
}

export function renderInOrganization(
  ui: ReactElement,
  context: OrganizationContext,
  {
    locale = 'en' as AppLocale,
    initialEntries = ['/'],
  }: { locale?: AppLocale; initialEntries?: string[] } = {},
): RenderResult & { locale: AppLocale; router: typeof testRouter } {
  stubLocation(initialEntries[0] ?? '/');
  const result = renderWithProviders(ui, { locale, organization: context });

  return Object.assign(result, { router: testRouter });
}

export { arabic, english };
