import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/application-api';
import {
  authClientStub,
  resetAuthClientStub,
} from '@/test/auth-client-stub';
import { context, member, organization } from '@/test/organization-fixtures';
import { renderInOrganization } from '@/test/render';

vi.mock('@/features/auth/auth-client', async () => {
  const { authClientStub } = await import('@/test/auth-client-stub');

  return { authClient: authClientStub };
});

const listAgentActionApprovals = vi.fn();
const approveAgentAction = vi.fn();
const rejectAgentAction = vi.fn();

vi.mock('../organization-api', async () => {
  const actual = await vi.importActual<typeof import('../organization-api')>(
    '../organization-api',
  );

  return {
    ...actual,
    listAgentActionApprovals: (...args: unknown[]) =>
      listAgentActionApprovals(...args),
    approveAgentAction: (...args: unknown[]) => approveAgentAction(...args),
    rejectAgentAction: (...args: unknown[]) => rejectAgentAction(...args),
  };
});

const { OrganizationApprovalsBlock } = await import(
  './organization-approvals-block'
);

const proposal = (overrides: Record<string, unknown> = {}) => ({
  toolExecutionId: 'exec_1',
  organizationId: 'org_1',
  agentRunId: 'run_1',
  agentId: 'content-project-handoff',
  agentVersion: 1,
  toolId: 'notification.send',
  toolVersion: 1,
  executionStatus: 'AWAITING_APPROVAL',
  approval: {
    status: 'PENDING',
    requestedAt: '2026-09-02T10:00:00.000Z',
    decidedAt: null,
    decidedByUserId: null,
    decisionNote: null,
  },
  proposal: {
    kind: 'notification.send@1',
    recipient: { memberId: 'm_1', name: 'Sara Haddad', email: 'sara@example.com' },
    subject: 'Kettle teardown is ready',
    body: 'The draft is waiting for you.',
  },
  effect: {
    attemptCount: 0,
    firstAttemptedAt: null,
    completedAt: null,
    failureCode: null,
  },
  ...overrides,
});

const render = (role: 'owner' | 'admin' | 'member' = 'owner') =>
  renderInOrganization(
    <OrganizationApprovalsBlock />,
    context({ organization: organization(), viewer: { userId: 'user_owner', member: member({ role }) } }),
  );

describe('organization approvals block', () => {
  beforeEach(() => {
    resetAuthClientStub();
    listAgentActionApprovals.mockReset();
    approveAgentAction.mockReset();
    rejectAgentAction.mockReset();
  });

  it('asks for pending proposals first and shows what the agent wrote', async () => {
    authClientStub.organization.checkRolePermission.mockReturnValue(true);
    listAgentActionApprovals.mockResolvedValue({
      items: [proposal()],
      nextCursor: null,
    });

    render();

    expect(await screen.findByText('Kettle teardown is ready')).toBeInTheDocument();
    expect(screen.getByText(/sara@example.com/)).toBeInTheDocument();
    expect(listAgentActionApprovals.mock.calls[0]?.[1]).toMatchObject({
      status: 'PENDING',
    });
  });

  it('says so when nothing is waiting', async () => {
    authClientStub.organization.checkRolePermission.mockReturnValue(true);
    listAgentActionApprovals.mockResolvedValue({ items: [], nextCursor: null });

    render();

    expect(await screen.findByText(/nothing waiting/i)).toBeInTheDocument();
  });

  /**
   * The decide buttons are a courtesy gate, evaluated from the viewer's role
   * in this organization. A member sees the proposal and no buttons; the
   * server would refuse the click anyway.
   */
  it('offers no decision to a role that may not decide', async () => {
    authClientStub.organization.checkRolePermission.mockReturnValue(false);
    listAgentActionApprovals.mockResolvedValue({
      items: [proposal()],
      nextCursor: null,
    });

    render('member');

    await screen.findByText('Kettle teardown is ready');
    expect(screen.queryByRole('button', { name: /approve and send/i })).toBeNull();
    expect(screen.getByText(/only an organization admin or owner/i)).toBeInTheDocument();
  });

  it('approves in place and shows the decided state', async () => {
    authClientStub.organization.checkRolePermission.mockReturnValue(true);
    listAgentActionApprovals.mockResolvedValue({
      items: [proposal()],
      nextCursor: null,
    });
    approveAgentAction.mockResolvedValue(
      proposal({
        executionStatus: 'APPROVED',
        approval: {
          status: 'APPROVED',
          requestedAt: '2026-09-02T10:00:00.000Z',
          decidedAt: '2026-09-02T10:05:00.000Z',
          decidedByUserId: 'user_owner',
          decisionNote: 'Looks good',
        },
      }),
    );

    render();

    await screen.findByText('Kettle teardown is ready');
    await userEvent.type(screen.getByLabelText(/optional note/i), 'Looks good');
    await userEvent.click(screen.getByRole('button', { name: /approve and send/i }));

    await waitFor(() =>
      expect(approveAgentAction).toHaveBeenCalledWith('org_1', 'exec_1', 'Looks good'),
    );
    expect(await screen.findByText('Queued to send')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve and send/i })).toBeNull();
    // Decided in place: no refetch of the list.
    expect(listAgentActionApprovals).toHaveBeenCalledTimes(1);
  });

  it('rejects without a note when none was typed', async () => {
    authClientStub.organization.checkRolePermission.mockReturnValue(true);
    listAgentActionApprovals.mockResolvedValue({
      items: [proposal()],
      nextCursor: null,
    });
    rejectAgentAction.mockResolvedValue(
      proposal({
        executionStatus: 'REJECTED',
        approval: {
          status: 'REJECTED',
          requestedAt: '2026-09-02T10:00:00.000Z',
          decidedAt: '2026-09-02T10:05:00.000Z',
          decidedByUserId: 'user_owner',
          decisionNote: null,
        },
      }),
    );

    render();

    await screen.findByText('Kettle teardown is ready');
    await userEvent.click(screen.getByRole('button', { name: /^reject$/i }));

    await waitFor(() =>
      expect(rejectAgentAction).toHaveBeenCalledWith('org_1', 'exec_1', undefined),
    );
    // The decided badge, as distinct from the "Rejected" filter button.
    expect(
      await screen.findByText('Rejected', { selector: '[data-slot="badge"]' }),
    ).toBeInTheDocument();
  });

  /**
   * A 409 is not the reader's failure. Somebody else decided first, and the
   * copy says exactly that rather than "could not be recorded".
   */
  it('names a lost race for what it is', async () => {
    authClientStub.organization.checkRolePermission.mockReturnValue(true);
    listAgentActionApprovals.mockResolvedValue({
      items: [proposal()],
      nextCursor: null,
    });
    approveAgentAction.mockRejectedValue(new ApiError(409, 'CONFLICT'));

    render();

    await screen.findByText('Kettle teardown is ready');
    await userEvent.click(screen.getByRole('button', { name: /approve and send/i }));

    expect(await screen.findByText(/decided this one first/i)).toBeInTheDocument();
  });

  it('shows the effect outcome once the worker has settled it', async () => {
    authClientStub.organization.checkRolePermission.mockReturnValue(true);
    listAgentActionApprovals.mockResolvedValue({
      items: [
        proposal({
          executionStatus: 'FAILED',
          approval: {
            status: 'APPROVED',
            requestedAt: '2026-09-02T10:00:00.000Z',
            decidedAt: '2026-09-02T10:05:00.000Z',
            decidedByUserId: 'user_owner',
            decisionNote: null,
          },
          effect: {
            attemptCount: 1,
            firstAttemptedAt: '2026-09-02T10:05:01.000Z',
            completedAt: '2026-09-02T10:05:02.000Z',
            failureCode: 'precondition_recipient',
          },
        }),
      ],
      nextCursor: null,
    });

    render();

    expect(
      await screen.findByText(/no longer a deliverable member/i),
    ).toBeInTheDocument();
  });

  it('switches the filter and asks again', async () => {
    authClientStub.organization.checkRolePermission.mockReturnValue(true);
    listAgentActionApprovals.mockResolvedValue({ items: [], nextCursor: null });

    render();

    await screen.findByText(/nothing waiting/i);
    await userEvent.click(screen.getByRole('button', { name: 'All' }));

    await waitFor(() => expect(listAgentActionApprovals).toHaveBeenCalledTimes(2));
    expect(listAgentActionApprovals.mock.calls[1]?.[1]).not.toHaveProperty('status');
  });
});
