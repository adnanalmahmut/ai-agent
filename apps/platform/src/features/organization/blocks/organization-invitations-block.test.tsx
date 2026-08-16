import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  allowOrganizationPermissions as allow,
  authClientStub,
  fail,
  resetAuthClientStub,
} from '@/test/auth-client-stub';
import { resetNavigationStub, revalidateSpy } from '@/test/navigation-stub';
import { context, invitation, organization } from '@/test/organization-fixtures';
import { renderInOrganization } from '@/test/render';

vi.mock('@/features/auth/auth-client', async () => {
  const { authClientStub } = await import('@/test/auth-client-stub');
  return { authClient: authClientStub };
});

vi.mock('@/i18n/navigation', async () => import('@/test/navigation-stub'));

const { OrganizationInvitationsBlock } = await import(
  './organization-invitations-block'
);

beforeEach(() => {
  resetAuthClientStub();
  resetNavigationStub();
});

describe('the list', () => {
  it('shows a pending invitation with its address, role and status', () => {
    renderInOrganization(<OrganizationInvitationsBlock />, context());

    expect(screen.getByText('invitee@example.com')).toBeInTheDocument();
    expect(screen.getByText('Member')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
  });

  it('keeps the history rather than hiding what happened', () => {
    // Cancelled and accepted invitations are kept by the backend on purpose;
    // the page shows the same thing the database does.
    renderInOrganization(
      <OrganizationInvitationsBlock />,
      context({
        organization: organization({
          invitations: [
            invitation({ id: 'inv_a', status: 'canceled', email: 'a@example.com' }),
            invitation({ id: 'inv_b', status: 'accepted', email: 'b@example.com' }),
          ],
        }),
      }),
    );

    expect(screen.getByText('Withdrawn')).toBeInTheDocument();
    expect(screen.getByText('Accepted')).toBeInTheDocument();
  });

  it('counts only the pending ones', () => {
    renderInOrganization(
      <OrganizationInvitationsBlock />,
      context({
        organization: organization({
          invitations: [
            invitation({ id: 'inv_a', status: 'pending' }),
            invitation({ id: 'inv_b', status: 'canceled' }),
          ],
        }),
      }),
    );

    expect(
      screen.getByText('1 invitation is waiting to be accepted'),
    ).toBeInTheDocument();
  });

  it('says so when there are none', () => {
    renderInOrganization(
      <OrganizationInvitationsBlock />,
      context({ organization: organization({ invitations: [] }) }),
    );

    expect(screen.getByText('No invitations yet')).toBeInTheDocument();
  });
});

describe('inviting', () => {
  beforeEach(() => allow('invitation:create'));

  it('sends the address and role, and asks for a resend', async () => {
    // `resend: true` is what makes "invite again" work: Better Auth has no
    // resend route, and re-inviting is the operation that exists.
    const user = userEvent.setup();
    renderInOrganization(<OrganizationInvitationsBlock />, context());

    await user.type(screen.getByLabelText('Email address'), 'new@example.com');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));

    await waitFor(() =>
      expect(authClientStub.organization.inviteMember).toHaveBeenCalledWith({
        organizationId: 'org_1',
        email: 'new@example.com',
        role: 'member',
        resend: true,
      }),
    );
  });

  it('confirms without saying whether the address has an account', async () => {
    // Inviting a deactivated account does not restore it, and this screen may
    // not reveal that one exists.
    const user = userEvent.setup();
    renderInOrganization(<OrganizationInvitationsBlock />, context());

    await user.type(screen.getByLabelText('Email address'), 'new@example.com');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));

    expect(
      await screen.findByText(/An invitation was sent to/),
    ).toBeInTheDocument();
    expect(revalidateSpy).toHaveBeenCalled();
  });

  it('refuses a malformed address without calling the server', async () => {
    const user = userEvent.setup();
    renderInOrganization(<OrganizationInvitationsBlock />, context());

    await user.type(screen.getByLabelText('Email address'), 'not-an-address');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));

    expect(
      await screen.findByText('That does not look like an email address.'),
    ).toBeInTheDocument();
    expect(authClientStub.organization.inviteMember).not.toHaveBeenCalled();
  });

  it('reports somebody who is already a member', async () => {
    authClientStub.organization.inviteMember.mockResolvedValue(
      fail('USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION', 400),
    );

    const user = userEvent.setup();
    renderInOrganization(<OrganizationInvitationsBlock />, context());

    await user.type(screen.getByLabelText('Email address'), 'new@example.com');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));

    expect(
      await screen.findByText(
        'That person is already a member of this organization.',
      ),
    ).toBeInTheDocument();
  });

  it('reports a member limit', async () => {
    authClientStub.organization.inviteMember.mockResolvedValue(
      fail('ORGANIZATION_MEMBERSHIP_LIMIT_REACHED', 403),
    );

    const user = userEvent.setup();
    renderInOrganization(<OrganizationInvitationsBlock />, context());

    await user.type(screen.getByLabelText('Email address'), 'new@example.com');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));

    expect(
      await screen.findByText(
        'This organization has reached its member limit.',
      ),
    ).toBeInTheDocument();
  });

  it('reports a role it may not hand out, rather than hiding the option', async () => {
    // Whether this caller may grant `owner` is the server's decision; the
    // select offers every role and surfaces the refusal.
    authClientStub.organization.inviteMember.mockResolvedValue(
      fail('YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE', 403),
    );

    const user = userEvent.setup();
    renderInOrganization(<OrganizationInvitationsBlock />, context());

    await user.type(screen.getByLabelText('Email address'), 'new@example.com');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));

    expect(
      await screen.findByText('You are not allowed to assign that role.'),
    ).toBeInTheDocument();
  });
});

describe('withdrawing', () => {
  it('is offered only with the permission', () => {
    renderInOrganization(<OrganizationInvitationsBlock />, context());

    expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull();
  });

  it('cancels and revalidates', async () => {
    allow('invitation:cancel');

    const user = userEvent.setup();
    renderInOrganization(<OrganizationInvitationsBlock />, context());

    await user.click(screen.getByRole('button', { name: 'Withdraw' }));

    await waitFor(() =>
      expect(authClientStub.organization.cancelInvitation).toHaveBeenCalledWith({
        invitationId: 'inv_1',
      }),
    );
    expect(revalidateSpy).toHaveBeenCalled();
  });

  it('is not offered for an invitation that is no longer pending', () => {
    allow('invitation:cancel');

    renderInOrganization(
      <OrganizationInvitationsBlock />,
      context({
        organization: organization({
          invitations: [invitation({ status: 'accepted' })],
        }),
      }),
    );

    expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull();
  });
});

describe('without permission', () => {
  it('offers no invite form at all', () => {
    renderInOrganization(<OrganizationInvitationsBlock />, context());

    expect(screen.queryByLabelText('Email address')).toBeNull();
  });
});
