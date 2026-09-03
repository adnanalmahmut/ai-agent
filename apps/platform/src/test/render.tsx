import { LOCALE_META, type AppLocale } from '@repo/i18n-core';
import { DirectionProvider } from '@repo/ui';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { IntlProvider } from 'use-intl';

import type { PlatformSession } from '@/features/auth/session-types';
import { PlatformSessionProvider } from '@/features/auth/use-platform-session';
import {
  OrganizationProvider,
  type OrganizationContext,
} from '@/features/organization/organization-context';
import { stubLocation, testRouter } from '@/test/navigation-stub';

import arabic from '../../messages/ar.json';
import english from '../../messages/en.json';

/**
 * Renders a component the way the application does.
 *
 * The real dictionaries are used, not fixtures. A test that stubbed messages
 * would pass while the key it names is missing from `en.json`, which is
 * exactly the failure worth catching — and it means asserting on the text a
 * user actually reads.
 *
 * `DirectionProvider` is included because Radix's portalled menus take their
 * direction from context rather than from `<html dir>`, so a test that omitted
 * it would render the RTL case incorrectly and quietly pass.
 *
 * No router is mounted here on purpose. Component tests replace
 * `@/i18n/navigation` with a stub, so what they assert is *where* a component
 * navigates rather than what a router then did with it. Tests about routing
 * itself build a real router over the real route tree — see `router.test.tsx`,
 * which is the only place that arrangement proves anything.
 */
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

  const result = render(
    <IntlProvider locale={locale} messages={MESSAGES[locale]} timeZone="UTC">
      <DirectionProvider direction={direction}>
        <PlatformSessionProvider session={session}>
          {content}
        </PlatformSessionProvider>
      </DirectionProvider>
    </IntlProvider>,
  );

  return Object.assign(result, { locale });
}

/**
 * Renders a component that lives inside an organization's layout.
 *
 * The App Router organization layout supplies a React context, so component
 * tests mount that same provider directly.
 */
export function renderInOrganization(
  ui: ReactElement,
  context: OrganizationContext,
  {
    locale = 'en' as AppLocale,
    /**
     * Where the reader arrives, which for a screen that keeps state in the
     * query string is part of the input rather than scenery.
     *
     * The content-idea block carries its operation in `?operation=`, so
     * "reload with a run in the URL" is a test that starts at that URL — and
     * asserting recovery any other way would be asserting against a fiction of
     * the component's own plumbing.
     */
    initialEntries = ['/'],
  }: { locale?: AppLocale; initialEntries?: string[] } = {},
): RenderResult & { locale: AppLocale; router: typeof testRouter } {
  stubLocation(initialEntries[0] ?? '/');
  const result = renderWithProviders(ui, { locale, organization: context });

  return Object.assign(result, { router: testRouter });
}

export { arabic, english };
