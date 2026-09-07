import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render';

import arabic from '../../../messages/ar.json';
import english from '../../../messages/en.json';

const messagesFor = (locale: 'ar' | 'en') => (locale === 'ar' ? arabic : english);

let active: 'ar' | 'en' = 'en';

vi.mock('next-intl/server', () => ({
  getTranslations: (namespace: 'forbidden' | 'unavailable') =>
    Promise.resolve((key: string) => {
      const section = messagesFor(active)[namespace] as Record<string, string>;

      return section[key];
    }),
}));
vi.mock('@/components/language-switcher', () => ({
  LanguageSwitcher: () => null,
}));

const { ForbiddenNotice, UnavailableNotice } = await import('./access-notice');

describe('what a refused reader is told', () => {
  it('says they have no access, and only that', async () => {
    active = 'en';
    renderWithProviders(await ForbiddenNotice());

    expect(
      screen.getByText('You do not have access to the administrative workspace.'),
    ).toBeInTheDocument();
  });

  it('names no permission, role or staff list', async () => {
    active = 'en';
    const { container } = renderWithProviders(await ForbiddenNotice());

    // What somebody would need in order to have access is not something a
    // refusal should teach them.
    // Word boundaries on purpose: calling the place an "administrative
    // workspace" is fine, naming the role that would let somebody in is not.
    expect(container.textContent).not.toMatch(
      /\b(admin|super_admin|controlPlane|role|permission|staff)\b/i,
    );
  });

  it('lets them leave the session they are actually in', async () => {
    active = 'en';
    renderWithProviders(await ForbiddenNotice());

    expect(
      screen.getByRole('button', { name: 'Sign out' }),
    ).toBeInTheDocument();
  });

  it('is translated', async () => {
    active = 'ar';
    renderWithProviders(await ForbiddenNotice(), { locale: 'ar' });

    expect(
      screen.getByText('ليس لديك وصول إلى مساحة العمل الإدارية.'),
    ).toBeInTheDocument();
  });
});

describe('what a reader whose access could not be established is told', () => {
  it('does not read as a refusal of the person', async () => {
    active = 'en';
    renderWithProviders(await UnavailableNotice());

    expect(screen.getByText('Temporarily unavailable')).toBeInTheDocument();
    // Nothing to sign out of: the session could not be read either way.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
