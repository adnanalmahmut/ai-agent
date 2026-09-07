import { LOCALE_META, type AppLocale } from '@repo/i18n-core';
import { DirectionProvider } from '@repo/ui';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { IntlProvider } from 'use-intl';

import arabic from '../../messages/ar.json';
import english from '../../messages/en.json';

const MESSAGES = { ar: arabic, en: english } as const;

export function renderWithProviders(
  ui: ReactElement,
  { locale = 'en' as AppLocale }: { locale?: AppLocale } = {},
): RenderResult & { locale: AppLocale } {
  const { direction } = LOCALE_META[locale];

  const result = render(
    <IntlProvider locale={locale} messages={MESSAGES[locale]} timeZone="UTC">
      <DirectionProvider direction={direction}>{ui}</DirectionProvider>
    </IntlProvider>,
  );

  return Object.assign(result, { locale });
}

export { arabic, english };
