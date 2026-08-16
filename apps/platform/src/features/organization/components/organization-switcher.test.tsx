import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authClientStub, resetAuthClientStub } from '@/test/auth-client-stub';
import { resetNavigationStub, revalidateSpy } from '@/test/navigation-stub';
import { renderWithProviders } from '@/test/render';

vi.mock('@/features/auth/auth-client', async () => {
  const { authClientStub } = await import('@/test/auth-client-stub');
  return { authClient: authClientStub };
});

vi.mock('@/i18n/navigation', async () => import('@/test/navigation-stub'));

const { OrganizationSwitcher } = await import('./organization-switcher');

const ACME = { id: 'org_1', name: 'Acme', slug: 'acme' };
const GLOBEX = { id: 'org_2', name: 'Globex', slug: 'globex' };

const withOrganizations = (
  organizations: typeof ACME[],
  active: typeof ACME | null = null,
  isPending = false,
) => {
  authClientStub.useListOrganizations.mockReturnValue({
    data: organizations,
    isPending,
  } as never);
  authClientStub.useActiveOrganization.mockReturnValue({
    data: active,
    isPending: false,
  } as never);
};

beforeEach(() => {
  resetAuthClientStub();
  resetNavigationStub();
});

describe('states', () => {
  it('shows a skeleton while the list loads', () => {
    withOrganizations([], null, true);

    renderWithProviders(<OrganizationSwitcher />);

    expect(screen.getByLabelText('Loading organizations')).toBeInTheDocument();
  });

  it('explains the empty case instead of offering an empty menu', () => {
    // A user with no organization is normal here — membership arrives by
    // invitation — so this state gets a sentence, not a dead dropdown.
    withOrganizations([]);

    renderWithProviders(<OrganizationSwitcher />);

    expect(screen.getByText('No organization yet')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('names the active organization on the trigger', () => {
    withOrganizations([ACME, GLOBEX], ACME);

    renderWithProviders(<OrganizationSwitcher />);

    expect(
      screen.getByRole('button', { name: /Acme/ }),
    ).toBeInTheDocument();
  });

  it('prompts for a choice when memberships exist but none is active', () => {
    withOrganizations([ACME, GLOBEX], null);

    renderWithProviders(<OrganizationSwitcher />);

    expect(
      screen.getByRole('button', { name: /Select an organization/ }),
    ).toBeInTheDocument();
  });
});

describe('switching', () => {
  it('asks the server to change the active organization', async () => {
    // A server operation: it writes `activeOrganizationId` onto the session
    // row and re-issues the cookie. There is no client state to update.
    const user = userEvent.setup();
    withOrganizations([ACME, GLOBEX], ACME);

    renderWithProviders(<OrganizationSwitcher />);

    await user.click(screen.getByRole('button', { name: /Acme/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Globex' }));

    await waitFor(() => {
      expect(authClientStub.organization.setActive).toHaveBeenCalledWith({
        organizationId: 'org_2',
      });
    });
  });

  it('revalidates the server-rendered tree afterwards', async () => {
    const user = userEvent.setup();
    withOrganizations([ACME, GLOBEX], ACME);

    renderWithProviders(<OrganizationSwitcher />);

    await user.click(screen.getByRole('button', { name: /Acme/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Globex' }));

    await waitFor(() => expect(revalidateSpy).toHaveBeenCalled());
  });

  it('refreshes even when the switch is refused', async () => {
    // The backend *clears* the active organization when the membership check
    // fails, so the user really is now in none — the UI has to say so.
    const user = userEvent.setup();
    authClientStub.organization.setActive.mockResolvedValue({
      data: null,
      error: { code: 'USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION', status: 403 },
    });
    withOrganizations([ACME, GLOBEX], ACME);

    renderWithProviders(<OrganizationSwitcher />);

    await user.click(screen.getByRole('button', { name: /Acme/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Globex' }));

    await waitFor(() => expect(revalidateSpy).toHaveBeenCalled());
  });

  it('does not re-select the organization already active', async () => {
    const user = userEvent.setup();
    withOrganizations([ACME, GLOBEX], ACME);

    renderWithProviders(<OrganizationSwitcher />);

    await user.click(screen.getByRole('button', { name: /Acme/ }));

    expect(await screen.findByRole('menuitem', { name: 'Acme' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});

describe('localisation', () => {
  it('labels the empty state in Arabic', () => {
    withOrganizations([]);

    renderWithProviders(<OrganizationSwitcher />, { locale: 'ar' });

    expect(screen.getByText('لا توجد مؤسسة بعد')).toBeInTheDocument();
  });
});
