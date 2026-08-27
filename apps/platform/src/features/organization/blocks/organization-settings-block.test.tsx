import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  allowOrganizationPermissions as allow,
  authClientStub,
  fail,
  resetAuthClientStub,
} from '@/test/auth-client-stub';
import {
  navigateSpy,
  resetNavigationStub,
  revalidateSpy,
} from '@/test/navigation-stub';
import { context } from '@/test/organization-fixtures';
import { renderInOrganization } from '@/test/render';

vi.mock('@/features/auth/auth-client', async () => {
  const { authClientStub } = await import('@/test/auth-client-stub');
  return { authClient: authClientStub };
});

vi.mock('@/i18n/navigation', async () => import('@/test/navigation-stub'));

const archiveOrganization = vi.fn();
const replaceOrganizationBusinessProfile = vi.fn();

vi.mock('../organization-api', () => ({
  archiveOrganization: (...args: unknown[]) => archiveOrganization(...args),
  replaceOrganizationBusinessProfile: (...args: unknown[]) =>
    replaceOrganizationBusinessProfile(...args),
  getOrganizationBusinessProfile: vi.fn(),
  restoreOrganization: vi.fn(),
  listArchivedOrganizations: vi.fn(),
}));

const { OrganizationSettingsBlock } =
  await import('./organization-settings-block');

beforeEach(() => {
  resetAuthClientStub();
  resetNavigationStub();
  archiveOrganization.mockReset();
  archiveOrganization.mockResolvedValue({ organizationId: 'org_1' });
  replaceOrganizationBusinessProfile.mockReset();
  replaceOrganizationBusinessProfile.mockResolvedValue({
    organizationId: 'org_1',
    version: 2,
  });
});

const businessProfile = () => ({
  profile: {
    organizationId: 'org_1',
    version: 1,
    locale: 'ar' as const,
    timezone: 'UTC',
    currency: 'USD',
    legalName: 'Acme Research LLC',
    industry: 'Research',
    websiteUrl: 'https://example.com',
    businessDescription: 'A research studio.',
    updatedAt: '2026-08-27T00:00:00.000Z',
  },
  error: null,
});

describe('the profile form', () => {
  beforeEach(() => allow('organization:update'));

  it('starts from what the organization currently is', () => {
    renderInOrganization(<OrganizationSettingsBlock />, context());

    expect(screen.getByLabelText('Organization name')).toHaveValue(
      'Acme Research',
    );
    expect(screen.getByLabelText('Address')).toHaveValue('acme-research');
  });

  it('saves a new name and address', async () => {
    const user = userEvent.setup();
    renderInOrganization(<OrganizationSettingsBlock />, context());

    await user.clear(screen.getByLabelText('Organization name'));
    await user.type(screen.getByLabelText('Organization name'), 'Acme Labs');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(authClientStub.organization.update).toHaveBeenCalledWith({
        organizationId: 'org_1',
        data: { name: 'Acme Labs', slug: 'acme-research' },
      }),
    );
  });

  it('confirms the save and revalidates', async () => {
    const user = userEvent.setup();
    renderInOrganization(<OrganizationSettingsBlock />, context());

    await user.type(screen.getByLabelText('Organization name'), '!');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(
      await screen.findByText('Your changes were saved.'),
    ).toBeInTheDocument();
    expect(revalidateSpy).toHaveBeenCalled();
  });

  it('reports a taken address', async () => {
    authClientStub.organization.update.mockResolvedValue(
      fail('ORGANIZATION_SLUG_ALREADY_TAKEN', 400),
    );

    const user = userEvent.setup();
    renderInOrganization(<OrganizationSettingsBlock />, context());

    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(
      await screen.findByText(
        'That address is already taken. Try another one.',
      ),
    ).toBeInTheDocument();
  });

  it('refuses an invalid address before the server sees it', async () => {
    const user = userEvent.setup();
    renderInOrganization(<OrganizationSettingsBlock />, context());

    await user.clear(screen.getByLabelText('Address'));
    await user.type(screen.getByLabelText('Address'), 'Bad Slug');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(
      await screen.findByText(
        'Use lowercase letters, numbers and single hyphens.',
      ),
    ).toBeInTheDocument();
    expect(authClientStub.organization.update).not.toHaveBeenCalled();
  });
});

describe('without the update permission', () => {
  it('shows the settings as read-only rather than a broken form', () => {
    renderInOrganization(<OrganizationSettingsBlock />, context());

    expect(
      screen.getByText('You cannot change these settings'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Organization name')).toBeNull();
  });
});

describe('the business defaults form', () => {
  beforeEach(() => allow('organization:update'));

  it('starts from the typed profile returned for this organization', () => {
    renderInOrganization(
      <OrganizationSettingsBlock businessProfile={businessProfile()} />,
      context(),
    );

    expect(screen.getByLabelText('Legal business name')).toHaveValue(
      'Acme Research LLC',
    );
    expect(screen.getByLabelText('Website')).toHaveValue('https://example.com');
    expect(screen.getByLabelText('Business description')).toHaveValue(
      'A research studio.',
    );
  });

  it('saves only the typed profile contract and revalidates', async () => {
    const user = userEvent.setup();
    renderInOrganization(
      <OrganizationSettingsBlock businessProfile={businessProfile()} />,
      context(),
    );

    await user.clear(screen.getByLabelText('Legal business name'));
    await user.type(screen.getByLabelText('Legal business name'), 'Acme Labs');
    await user.click(
      screen.getByRole('button', { name: 'Save business defaults' }),
    );

    await waitFor(() =>
      expect(replaceOrganizationBusinessProfile).toHaveBeenCalledWith('org_1', {
        version: 1,
        locale: 'ar',
        timezone: 'UTC',
        currency: 'USD',
        legalName: 'Acme Labs',
        industry: 'Research',
        websiteUrl: 'https://example.com',
        businessDescription: 'A research studio.',
      }),
    );
    expect(
      await screen.findByText('Business defaults were saved.'),
    ).toBeInTheDocument();
    expect(revalidateSpy).toHaveBeenCalled();
  });

  it('reports a concurrent update instead of claiming success', async () => {
    const { ApiError } = await import('@/lib/application-api');
    replaceOrganizationBusinessProfile.mockRejectedValue(
      new ApiError(409, 'CONFLICT'),
    );
    const user = userEvent.setup();
    renderInOrganization(
      <OrganizationSettingsBlock businessProfile={businessProfile()} />,
      context(),
    );

    await user.click(
      screen.getByRole('button', { name: 'Save business defaults' }),
    );

    expect(
      await screen.findByText(
        'These settings changed elsewhere. Review the latest values and try again.',
      ),
    ).toBeInTheDocument();
  });
});

describe('the danger zone', () => {
  it('is absent without the archive permission', () => {
    // An organization admin holds `organization:update` but not
    // `organization:archive` — the backend withholds it, and so does this.
    allow('organization:update');
    renderInOrganization(<OrganizationSettingsBlock />, context());

    expect(screen.queryByText('Danger zone')).toBeNull();
  });

  it('appears for whoever holds it', () => {
    allow('organization:archive');
    renderInOrganization(<OrganizationSettingsBlock />, context());

    expect(screen.getByText('Danger zone')).toBeInTheDocument();
  });

  it('offers no hard delete', () => {
    // The backend disables organization deletion outright; a button here
    // could only ever produce a 404.
    allow('organization:archive', 'organization:update');
    renderInOrganization(<OrganizationSettingsBlock />, context());

    expect(screen.queryByRole('button', { name: /Delete/i })).toBeNull();
  });
});

describe('archiving', () => {
  beforeEach(() => allow('organization:archive'));

  it('asks first', async () => {
    const user = userEvent.setup();
    renderInOrganization(<OrganizationSettingsBlock />, context());

    await user.click(screen.getByRole('button', { name: 'Archive' }));

    expect(
      await screen.findByRole('dialog', { name: 'Archive this organization?' }),
    ).toBeInTheDocument();
    expect(archiveOrganization).not.toHaveBeenCalled();
  });

  it('spells out that nothing is deleted', async () => {
    // The honest description is the reassuring one. A generic "this cannot be
    // undone" would be both scarier and false.
    const user = userEvent.setup();
    renderInOrganization(<OrganizationSettingsBlock />, context());

    await user.click(screen.getByRole('button', { name: 'Archive' }));

    expect(
      await screen.findByText('Members keep their places — nobody is removed.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Everything created inside it is kept.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Invitations that had not been accepted are withdrawn.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('The organization can be restored at any time.'),
    ).toBeInTheDocument();
  });

  it('archives on confirmation and leaves the organization', async () => {
    const user = userEvent.setup();
    renderInOrganization(<OrganizationSettingsBlock />, context());

    await user.click(screen.getByRole('button', { name: 'Archive' }));
    await user.click(
      await screen.findByRole('button', { name: 'Archive organization' }),
    );

    await waitFor(() =>
      expect(archiveOrganization).toHaveBeenCalledWith('org_1', undefined),
    );
    await waitFor(() =>
      expect(navigateSpy).toHaveBeenCalledWith('/organizations', {
        replace: true,
      }),
    );
  });

  it('reports a refusal and stays put', async () => {
    const { ApiError } = await import('@/lib/application-api');
    archiveOrganization.mockRejectedValue(new ApiError(403, 'FORBIDDEN'));

    const user = userEvent.setup();
    renderInOrganization(<OrganizationSettingsBlock />, context());

    await user.click(screen.getByRole('button', { name: 'Archive' }));
    await user.click(
      await screen.findByRole('button', { name: 'Archive organization' }),
    );

    expect(
      await screen.findByText(
        'You do not have permission to do that in this organization.',
      ),
    ).toBeInTheDocument();
    expect(navigateSpy).not.toHaveBeenCalled();
  });
});
