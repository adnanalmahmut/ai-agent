import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  allowOrganizationPermissions as allow,
  authClientStub,
  fail,
  resetAuthClientStub,
} from '@/test/auth-client-stub';
import { navigateSpy, resetNavigationStub, revalidateSpy } from '@/test/navigation-stub';
import { context, member, organization, VIEWER_ID } from '@/test/organization-fixtures';
import { renderInOrganization } from '@/test/render';

vi.mock('@/features/auth/auth-client', async () => {
  const { authClientStub } = await import('@/test/auth-client-stub');
  return { authClient: authClientStub };
});

vi.mock('@/i18n/navigation', async () => import('@/test/navigation-stub'));

const { OrganizationMembersBlock } = await import('./organization-members-block');

const OTHER = member({
  id: 'member_other',
  userId: 'user_other',
  role: 'member',
  user: {
    id: 'user_other',
    name: 'Omar Nassar',
    email: 'omar@example.com',
    image: null,
  },
});

const twoMembers = organization({ members: [member(), OTHER] });

beforeEach(() => {
  resetAuthClientStub();
  resetNavigationStub();
});

describe('the member list', () => {
  it('shows everybody in the organization', () => {
    renderInOrganization(<OrganizationMembersBlock />, context({ organization: twoMembers }));

    // Twice each: the table for wide screens and the card list for narrow
    // ones are both in the DOM, and CSS decides which one is seen.
    expect(screen.getAllByText('Sara Haddad')).toHaveLength(2);
    expect(screen.getAllByText('Omar Nassar')).toHaveLength(2);
  });

  it('renders a real table on wide screens, with column headers', () => {
    // The header row is what makes the table navigable by screen reader; a
    // grid of divs would look identical and announce nothing.
    renderInOrganization(<OrganizationMembersBlock />, context({ organization: twoMembers }));

    expect(
      screen.getByRole('columnheader', { name: 'Member' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: 'Role' }),
    ).toBeInTheDocument();
  });

  it('shows a role as plain text when the reader cannot change it', () => {
    renderInOrganization(<OrganizationMembersBlock />, context());

    // A disabled select would invite the reader to work out why it is
    // disabled. There is nothing to work out: the role is information here.
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    expect(screen.getAllByText('Owner').length).toBeGreaterThan(0);
  });
});

describe('changing a role', () => {
  beforeEach(() => allow('member:update'));

  it('offers a picker per member, labelled by who it is for', () => {
    renderInOrganization(<OrganizationMembersBlock />, context({ organization: twoMembers }));

    expect(
      screen.getAllByRole('combobox', { name: 'Role for Omar Nassar' }).length,
    ).toBeGreaterThan(0);
  });

  it('sends the change to the server and revalidates', async () => {
    const user = userEvent.setup();
    renderInOrganization(<OrganizationMembersBlock />, context({ organization: twoMembers }));

    const picker = screen.getAllByRole('combobox', {
      name: 'Role for Omar Nassar',
    })[0]!;

    await user.click(picker);
    await user.click(
      within(screen.getByRole('listbox')).getByRole('option', {
        name: 'Administrator',
      }),
    );

    await waitFor(() =>
      expect(authClientStub.organization.updateMemberRole).toHaveBeenCalledWith({
        organizationId: 'org_1',
        memberId: 'member_other',
        role: 'admin',
      }),
    );

    expect(revalidateSpy).toHaveBeenCalled();
  });

  it('reports a refusal in the reader’s language', async () => {
    authClientStub.organization.updateMemberRole.mockResolvedValue(
      fail('YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER', 403),
    );

    const user = userEvent.setup();
    renderInOrganization(<OrganizationMembersBlock />, context({ organization: twoMembers }));

    const picker = screen.getAllByRole('combobox', {
      name: 'Role for Omar Nassar',
    })[0]!;

    await user.click(picker);
    await user.click(
      within(screen.getByRole('listbox')).getByRole('option', {
        name: 'Administrator',
      }),
    );

    expect(
      await screen.findByText(
        'You do not have permission to do that in this organization.',
      ),
    ).toBeInTheDocument();
  });
});

describe('removing a member', () => {
  beforeEach(() => allow('member:delete'));

  it('asks before doing it', async () => {
    const user = userEvent.setup();
    renderInOrganization(<OrganizationMembersBlock />, context({ organization: twoMembers }));

    await user.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);

    expect(
      await screen.findByRole('dialog', { name: 'Remove this member?' }),
    ).toBeInTheDocument();
    expect(authClientStub.organization.removeMember).not.toHaveBeenCalled();
  });

  it('says plainly that nothing they made is deleted', async () => {
    const user = userEvent.setup();
    renderInOrganization(<OrganizationMembersBlock />, context({ organization: twoMembers }));

    await user.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);

    expect(
      await screen.findByText(/Nothing they created is deleted/),
    ).toBeInTheDocument();
  });

  it('removes on confirmation', async () => {
    const user = userEvent.setup();
    renderInOrganization(<OrganizationMembersBlock />, context({ organization: twoMembers }));

    await user.click(screen.getAllByRole('button', { name: 'Remove' })[1]!);
    await user.click(
      await screen.findByRole('button', { name: 'Remove member' }),
    );

    await waitFor(() =>
      expect(authClientStub.organization.removeMember).toHaveBeenCalledWith({
        organizationId: 'org_1',
        memberIdOrEmail: 'member_other',
      }),
    );
  });

  it('calls the reader’s own removal leaving, and takes them out', async () => {
    // Removing yourself is allowed, and afterwards every endpoint for this
    // organization refuses you — so staying on the page would mean watching
    // it fail to reload.
    const user = userEvent.setup();
    renderInOrganization(<OrganizationMembersBlock />, context({ organization: twoMembers }));

    await user.click(screen.getAllByRole('button', { name: 'Leave' })[0]!);
    await user.click(
      await screen.findByRole('button', { name: 'Leave organization' }),
    );

    await waitFor(() =>
      expect(navigateSpy).toHaveBeenCalledWith('/organizations', {
        replace: true,
      }),
    );
  });

  it('stays put when somebody else is removed', async () => {
    const user = userEvent.setup();
    renderInOrganization(<OrganizationMembersBlock />, context({ organization: twoMembers }));

    await user.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);
    await user.click(
      await screen.findByRole('button', { name: 'Remove member' }),
    );

    await waitFor(() => expect(revalidateSpy).toHaveBeenCalled());
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('surfaces the last-owner rule rather than pre-empting it', async () => {
    // The server owns that rule. Hiding the control would encode a copy of it
    // in the browser that could drift.
    authClientStub.organization.removeMember.mockResolvedValue(
      fail('YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER', 400),
    );

    const user = userEvent.setup();
    renderInOrganization(<OrganizationMembersBlock />, context({ organization: twoMembers }));

    await user.click(screen.getAllByRole('button', { name: 'Leave' })[0]!);
    await user.click(
      await screen.findByRole('button', { name: 'Leave organization' }),
    );

    expect(
      await screen.findByText(/at least one owner/),
    ).toBeInTheDocument();
  });
});

describe('without permission', () => {
  it('offers neither control', () => {
    // The gate is UX. The server refuses either way; this only avoids showing
    // a door that opens onto a 403.
    renderInOrganization(<OrganizationMembersBlock />, context({ organization: twoMembers }));

    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('asks about the viewer’s membership in *this* organization', () => {
    // Not the active one. A reader with organization A selected while reading
    // organization B must be judged by their role in B.
    renderInOrganization(
      <OrganizationMembersBlock />,
      context({
        organization: twoMembers,
        viewer: { userId: VIEWER_ID, member: null },
      }),
    );

    expect(
      authClientStub.organization.checkRolePermission,
    ).not.toHaveBeenCalled();
  });
});
