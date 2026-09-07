import userEvent from '@testing-library/user-event';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  allowGlobalPermissions,
  authClientStub,
  ok,
  resetAuthClientStub,
} from '@/test/auth-client-stub';
import { resetNavigationStub } from '@/test/navigation-stub';
import { renderWithProviders } from '@/test/render';

vi.mock('@/features/auth/auth-client', async () => {
  const { authClientStub } = await import('@/test/auth-client-stub');
  return { authClient: authClientStub };
});

vi.mock('@/i18n/navigation', async () => import('@/test/navigation-stub'));

const { AdminUsersBlock } = await import('./admin-users-block');
const { AdminUsersTable } = await import('./admin-users-table');

beforeEach(() => {
  resetAuthClientStub();
  resetNavigationStub();
  allowGlobalPermissions('user:list', 'user:set-role', 'user:ban');
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('AdminUsersBlock request concurrency (latest-request-wins)', () => {
  it('A starts -> B starts -> A finishes late -> B remains authoritative', async () => {
    let resolveRequestA!: (val: unknown) => void;
    let resolveRequestB!: (val: unknown) => void;

    const promiseA = new Promise((resolve) => {
      resolveRequestA = resolve;
    });
    const promiseB = new Promise((resolve) => {
      resolveRequestB = resolve;
    });

    let callCount = 0;
    authClientStub.admin.listUsers.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return promiseA as never;
      }
      return promiseB as never;
    });

    renderWithProviders(<AdminUsersBlock />);

    await sleep(350);
    expect(callCount).toBe(1);

    const searchInput = screen.getByRole('searchbox');
    fireEvent.change(searchInput, { target: { value: 'user-b' } });

    await sleep(350);
    expect(callCount).toBe(2);

    resolveRequestA(
      ok({
        users: [
          {
            id: 'user_a',
            name: 'Stale User A',
            email: 'a@example.com',
            emailVerified: true,
            role: 'user',
            createdAt: new Date().toISOString(),
          },
        ],
        total: 1,
      }),
    );

    await sleep(50);
    expect(screen.queryByText('Stale User A')).not.toBeInTheDocument();

    resolveRequestB(
      ok({
        users: [
          {
            id: 'user_b',
            name: 'Authoritative User B',
            email: 'b@example.com',
            emailVerified: true,
            role: 'user',
            createdAt: new Date().toISOString(),
          },
        ],
        total: 1,
      }),
    );

    expect(await screen.findByText('Authoritative User B')).toBeInTheDocument();
    expect(screen.queryByText('Stale User A')).not.toBeInTheDocument();
  });

  it('an aborted stale request cannot clear the current loading state', async () => {
    let resolveRequestA!: (val: unknown) => void;
    const promiseA = new Promise((resolve) => {
      resolveRequestA = resolve;
    });

    let callCount = 0;
    authClientStub.admin.listUsers.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return promiseA as never;
      }
      return new Promise(() => {}) as never;
    });

    renderWithProviders(<AdminUsersBlock />);

    await sleep(350);
    expect(callCount).toBe(1);

    const searchInput = screen.getByRole('searchbox');
    fireEvent.change(searchInput, { target: { value: 'query-2' } });

    await sleep(350);
    expect(callCount).toBe(2);

    resolveRequestA(
      ok({
        users: [],
        total: 0,
      }),
    );

    await sleep(50);
    expect(screen.getByText('Loading users...')).toBeInTheDocument();
  });
});

describe('super_admin selector handling in AdminUsersTable', () => {
  it('renders super_admin target as non-editable Badge instead of Select', () => {
    const superAdminUser = {
      id: 'target_super',
      name: 'Super User',
      email: 'super@example.com',
      emailVerified: true,
      role: 'super_admin',
      createdAt: new Date().toISOString(),
    };

    const normalUser = {
      id: 'target_normal',
      name: 'Normal User',
      email: 'normal@example.com',
      emailVerified: true,
      role: 'user',
      createdAt: new Date().toISOString(),
    };

    renderWithProviders(
      <AdminUsersTable
        users={[superAdminUser, normalUser]}
        actionUserId={null}
        onRoleChange={vi.fn()}
        onBanClick={vi.fn()}
        onUnban={vi.fn()}
        onDeactivate={vi.fn()}
        onRestore={vi.fn()}
        onImpersonate={vi.fn()}
      />,
    );

    expect(screen.getByText('Super Administrator')).toBeInTheDocument();

    const comboboxes = screen.getAllByRole('combobox');
    expect(comboboxes).toHaveLength(1);
  });
});

describe('admin query lifecycle', () => {
  const user = {
    id: 'user_1',
    name: 'Listed user',
    email: 'listed@example.com',
    role: 'user',
    emailVerified: true,
    banned: true,
    createdAt: '2026-01-01T00:00:00Z',
  };
  it('debounces initial and subsequent searches for 300ms, including clearing search', async () => {
    vi.useFakeTimers();
    try {
      authClientStub.admin.listUsers.mockResolvedValue(
        ok({ users: [], total: 0 }),
      );
      renderWithProviders(<AdminUsersBlock />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(299);
      });
      expect(authClientStub.admin.listUsers).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(authClientStub.admin.listUsers).toHaveBeenCalledTimes(1);
      fireEvent.change(screen.getByRole('searchbox'), {
        target: { value: 'first' },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      fireEvent.change(screen.getByRole('searchbox'), {
        target: { value: 'final' },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(299);
      });
      expect(authClientStub.admin.listUsers).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(authClientStub.admin.listUsers).toHaveBeenLastCalledWith({
        query: { limit: 100, searchValue: 'final' },
        fetchOptions: { signal: expect.any(AbortSignal) },
      });
      fireEvent.change(screen.getByRole('searchbox'), {
        target: { value: '' },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(authClientStub.admin.listUsers).toHaveBeenLastCalledWith({
        query: { limit: 100, searchValue: undefined },
        fetchOptions: { signal: expect.any(AbortSignal) },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['returned', 'thrown'])(
    'shows a %s read failure and retries on demand',
    async (kind) => {
      if (kind === 'returned')
        authClientStub.admin.listUsers.mockResolvedValueOnce({
          data: null,
          error: { message: 'refused' },
        });
      else
        authClientStub.admin.listUsers.mockRejectedValueOnce(
          new Error('offline'),
        );
      authClientStub.admin.listUsers.mockResolvedValueOnce(
        ok({ users: [user], total: 1 }),
      );
      renderWithProviders(<AdminUsersBlock />);
      await screen.findByText('Failed to load users list.');
      expect(authClientStub.admin.listUsers).toHaveBeenCalledTimes(1);
      await userEvent.click(screen.getByRole('button', { name: /retry/i }));
      await screen.findByText('Listed user');
    },
  );

  it('invalidates the current search after a write and preserves protocol errors', async () => {
    authClientStub.admin.listUsers.mockResolvedValue(
      ok({ users: [user], total: 1 }),
    );
    authClientStub.admin.unbanUser
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'Cannot unban this user' },
      })
      .mockResolvedValueOnce(ok({ status: true }));
    renderWithProviders(<AdminUsersBlock />);
    await screen.findByText('Listed user');
    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: 'listed' },
    });
    await waitFor(() =>
      expect(authClientStub.admin.listUsers).toHaveBeenCalledTimes(2),
    );
    await screen.findByText('Listed user');
    await userEvent.click(screen.getByTitle('Unban User'));
    await screen.findByText('Cannot unban this user');
    expect(authClientStub.admin.listUsers).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByTitle('Unban User'));
    await waitFor(() =>
      expect(authClientStub.admin.listUsers).toHaveBeenCalledTimes(3),
    );
    expect(authClientStub.admin.listUsers).toHaveBeenLastCalledWith({
      query: { limit: 100, searchValue: 'listed' },
      fetchOptions: { signal: expect.any(AbortSignal) },
    });
    expect(
      screen.queryByText('Cannot unban this user'),
    ).not.toBeInTheDocument();
  });
});

it('cancels superseded searches and ignores a late rejection', async () => {
  let reject!: (error: Error) => void;
  let signal: AbortSignal | undefined;
  authClientStub.admin.listUsers
    .mockImplementationOnce(
      (options?: { fetchOptions?: { signal?: AbortSignal } }) => {
        signal = options?.fetchOptions?.signal;
        return new Promise((_yes, no) => {
          reject = no;
        });
      },
    )
    .mockResolvedValueOnce(ok({ users: [], total: 0 }));
  const view = renderWithProviders(<AdminUsersBlock />);
  await waitFor(() =>
    expect(authClientStub.admin.listUsers).toHaveBeenCalledTimes(1),
  );
  fireEvent.change(screen.getByRole('searchbox'), {
    target: { value: 'current' },
  });
  await waitFor(() =>
    expect(authClientStub.admin.listUsers).toHaveBeenCalledTimes(2),
  );
  expect(signal?.aborted).toBe(true);
  await act(async () => reject(new Error('obsolete failure')));
  expect(
    screen.queryByText('Failed to load users list.'),
  ).not.toBeInTheDocument();
  view.unmount();
});
