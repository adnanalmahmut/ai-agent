import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  authClientStub,
  fail,
  ok,
  resetAuthClientStub,
} from '@/test/auth-client-stub';
import {
  navigateSpy,
  resetNavigationStub,
  revalidateSpy,
} from '@/test/navigation-stub';
import { renderWithProviders } from '@/test/render';

vi.mock('@/features/auth/auth-client', async () => {
  const { authClientStub } = await import('@/test/auth-client-stub');
  return { authClient: authClientStub };
});

vi.mock('@/i18n/navigation', async () => import('@/test/navigation-stub'));

const { CreateOrganizationBlock } = await import('./create-organization-block');

beforeEach(() => {
  resetAuthClientStub();
  resetNavigationStub();
});

async function fill(name = 'Acme Research', slug?: string) {
  const user = userEvent.setup();

  await user.type(screen.getByLabelText('Organization name'), name);

  if (slug !== undefined) {
    await user.clear(screen.getByLabelText('Address'));
    await user.type(screen.getByLabelText('Address'), slug);
  }

  return user;
}

describe('the form', () => {
  it('suggests an address from the name', async () => {
    renderWithProviders(<CreateOrganizationBlock />);

    await fill('Acme Research');

    expect(screen.getByLabelText('Address')).toHaveValue('acme-research');
  });

  it('stops suggesting once the reader edits the address', async () => {
    renderWithProviders(<CreateOrganizationBlock />);

    const user = await fill('Acme', 'my-own-choice');
    await user.type(screen.getByLabelText('Organization name'), ' Research');

    expect(screen.getByLabelText('Address')).toHaveValue('my-own-choice');
  });

  it('suggests nothing for a name in a non-Latin script', async () => {
    renderWithProviders(<CreateOrganizationBlock />, { locale: 'ar' });

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('اسم المؤسسة'), 'أبحاث أكمي');

    expect(screen.getByLabelText('العنوان')).toHaveValue('');
  });
});

describe('validation', () => {
  it('refuses an empty name without calling the server', async () => {
    renderWithProviders(<CreateOrganizationBlock />);

    const user = userEvent.setup();
    await user.click(
      screen.getByRole('button', { name: 'Create organization' }),
    );

    expect(
      await screen.findByText('Enter a name for the organization.'),
    ).toBeInTheDocument();
    expect(authClientStub.organization.create).not.toHaveBeenCalled();
  });

  it('refuses an address with illegal characters', async () => {
    renderWithProviders(<CreateOrganizationBlock />);

    const user = await fill('Acme', 'Not A Slug!');
    await user.click(
      screen.getByRole('button', { name: 'Create organization' }),
    );

    expect(
      await screen.findByText(
        'Use lowercase letters, numbers and single hyphens.',
      ),
    ).toBeInTheDocument();
    expect(authClientStub.organization.create).not.toHaveBeenCalled();
  });
});

describe('availability', () => {
  it('says when an address is free', async () => {
    renderWithProviders(<CreateOrganizationBlock />);

    await fill('Acme Research');

    expect(
      await screen.findByText('This address is available.'),
    ).toBeInTheDocument();
  });

  it('says when it is taken', async () => {
    authClientStub.organization.checkSlug.mockResolvedValue(
      ok({ status: false }),
    );
    renderWithProviders(<CreateOrganizationBlock />);

    await fill('Acme Research');

    expect(
      await screen.findByText('This address is already taken.'),
    ).toBeInTheDocument();
  });

  it('says nothing when the check itself fails', async () => {
    authClientStub.organization.checkSlug.mockRejectedValue(
      new Error('offline'),
    );
    renderWithProviders(<CreateOrganizationBlock />);

    await fill('Acme Research');

    await waitFor(() =>
      expect(authClientStub.organization.checkSlug).toHaveBeenCalled(),
    );
    expect(screen.queryByText('This address is already taken.')).toBeNull();
  });
});

describe('creating', () => {
  it('sends the name and address', async () => {
    renderWithProviders(<CreateOrganizationBlock />);

    const user = await fill('Acme Research');
    await user.click(
      screen.getByRole('button', { name: 'Create organization' }),
    );

    await waitFor(() =>
      expect(authClientStub.organization.create).toHaveBeenCalledWith({
        name: 'Acme Research',
        slug: 'acme-research',
        keepCurrentActiveOrganization: false,
      }),
    );
  });

  it('goes into the new organization, after revalidating', async () => {
    authClientStub.organization.create.mockResolvedValue(ok({ id: 'org_7' }));
    renderWithProviders(<CreateOrganizationBlock />);

    const user = await fill('Acme Research');
    await user.click(
      screen.getByRole('button', { name: 'Create organization' }),
    );

    await waitFor(() =>
      expect(navigateSpy).toHaveBeenCalledWith('/organizations/org_7', {
        replace: true,
      }),
    );
    expect(revalidateSpy).toHaveBeenCalled();
  });

  it('reports a duplicate address in the reader’s language', async () => {
    authClientStub.organization.create.mockResolvedValue(
      fail('ORGANIZATION_SLUG_ALREADY_TAKEN', 400),
    );
    renderWithProviders(<CreateOrganizationBlock />);

    const user = await fill('Acme Research');
    await user.click(
      screen.getByRole('button', { name: 'Create organization' }),
    );

    expect(
      await screen.findByText(
        'That address is already taken. Try another one.',
      ),
    ).toBeInTheDocument();
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('reports an organization limit', async () => {
    authClientStub.organization.create.mockResolvedValue(
      fail('YOU_HAVE_REACHED_THE_MAXIMUM_NUMBER_OF_ORGANIZATIONS', 403),
    );
    renderWithProviders(<CreateOrganizationBlock />);

    const user = await fill('Acme Research');
    await user.click(
      screen.getByRole('button', { name: 'Create organization' }),
    );

    expect(
      await screen.findByText(
        'You have reached the maximum number of organizations.',
      ),
    ).toBeInTheDocument();
  });

  it('reports an unreachable server as a network problem', async () => {
    authClientStub.organization.create.mockRejectedValue(
      new TypeError('fetch failed'),
    );
    renderWithProviders(<CreateOrganizationBlock />);

    const user = await fill('Acme Research');
    await user.click(
      screen.getByRole('button', { name: 'Create organization' }),
    );

    expect(
      await screen.findByText(
        'We could not reach the server. Check your connection and try again.',
      ),
    ).toBeInTheDocument();
  });
});
