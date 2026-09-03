import { fireEvent, screen } from '@testing-library/react';
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
