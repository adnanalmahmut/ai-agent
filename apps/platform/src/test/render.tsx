import { LOCALE_META, type AppLocale } from '@repo/i18n-core';
import { DirectionProvider } from '@repo/ui';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { IntlProvider } from 'use-intl';

import type { OrganizationContext } from '@/features/organization/organization-context';

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

export function renderWithProviders(
  ui: ReactElement,
  { locale = 'en' as AppLocale } = {},
): RenderResult & { locale: AppLocale } {
  const { direction } = LOCALE_META[locale];

  const result = render(
    <IntlProvider locale={locale} messages={MESSAGES[locale]} timeZone="UTC">
      <DirectionProvider direction={direction}>{ui}</DirectionProvider>
    </IntlProvider>,
  );

  return Object.assign(result, { locale });
}

/**
 * Renders a component that lives inside an organization's layout.
 *
 * The four organization tabs read their organization from the outlet context,
 * so a test has to supply one — which means a router, because that is what
 * `useOutletContext` reads from. A memory router with two routes is the
 * smallest honest way to do it; faking the context with a hand-rolled provider
 * would test a component against a fiction of its own plumbing.
 */
export function renderInOrganization(
  ui: ReactElement,
  context: OrganizationContext,
  { locale = 'en' as AppLocale } = {},
): RenderResult & { locale: AppLocale } {
  const { direction } = LOCALE_META[locale];

  const router = createMemoryRouter([
    {
      path: '/',
      element: (
        <IntlProvider locale={locale} messages={MESSAGES[locale]} timeZone="UTC">
          <DirectionProvider direction={direction}>
            <Outlet context={context} />
          </DirectionProvider>
        </IntlProvider>
      ),
      children: [{ index: true, element: ui }],
    },
  ]);

  const result = render(<RouterProvider router={router} />);

  return Object.assign(result, { locale });
}

export { arabic, english };
