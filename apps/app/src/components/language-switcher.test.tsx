import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  pushSpy,
  replaceSpy,
  resetNavigationStub,
  stubLocation,
} from '@/test/navigation-stub';
import { renderWithProviders } from '@/test/render';

vi.mock('@/i18n/navigation', async () => import('@/test/navigation-stub'));

const { LanguageSwitcher } = await import('./language-switcher');

beforeEach(resetNavigationStub);

async function chooseArabic() {
  const user = userEvent.setup();

  await user.click(screen.getByRole('button', { name: 'Change language' }));
  await user.click(await screen.findByRole('menuitem', { name: 'العربية' }));
}

describe('switching language', () => {
  it('keeps the page, its query and its anchor, and only changes the language', async () => {
    stubLocation('/some-page?tab=profile#security');

    renderWithProviders(<LanguageSwitcher />);
    await chooseArabic();

    await waitFor(() =>
      expect(replaceSpy).toHaveBeenCalledWith(
        '/some-page?tab=profile#security',
        { locale: 'ar' },
      ),
    );
  });

  it('replaces rather than pushes, so the back button does not undo the choice', async () => {
    stubLocation('/some-page');

    renderWithProviders(<LanguageSwitcher />);
    await chooseArabic();

    await waitFor(() => expect(replaceSpy).toHaveBeenCalled());
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('remembers the choice for the links this reader is emailed later', async () => {
    stubLocation('/some-page');

    renderWithProviders(<LanguageSwitcher />);
    await chooseArabic();

    await waitFor(() => expect(document.cookie).toContain('ar'));
  });

  it('does nothing when the reader picks the language they are already in', async () => {
    stubLocation('/some-page');

    renderWithProviders(<LanguageSwitcher />, { locale: 'ar' });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'تغيير اللغة' }));

    expect(
      await screen.findByRole('menuitem', { name: 'العربية' }),
    ).toHaveAttribute('aria-disabled', 'true');
    expect(replaceSpy).not.toHaveBeenCalled();
    expect(pushSpy).not.toHaveBeenCalled();
  });
});
