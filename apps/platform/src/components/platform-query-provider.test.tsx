import { useQuery, useQueryClient } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { PlatformQueryProvider } from './platform-query-provider';

/**
 * The provider itself is three lines of TanStack Query, so what is worth
 * testing is our side of it: that a client reaches the tree at all, that the
 * defaults are the ones the control-plane screens were written against, and
 * that one client belongs to one mounted tree rather than to the process.
 */

function Flags({ load }: { load: () => Promise<string> }) {
  const query = useQuery({ queryKey: ['probe'], queryFn: load });

  if (query.isPending) return <p>waiting</p>;
  if (query.isError) return <p>refused</p>;

  return <p>{query.data}</p>;
}

const mount = (ui: React.ReactElement) =>
  render(<PlatformQueryProvider>{ui}</PlatformQueryProvider>);

describe('PlatformQueryProvider', () => {
  it('lets a client component run a query', async () => {
    mount(<Flags load={() => Promise.resolve('loaded')} />);

    expect(screen.getByText('waiting')).toBeInTheDocument();
    await screen.findByText('loaded');
  });

  it('does not retry a failed query behind the operator', async () => {
    const load = vi.fn(() => Promise.reject(new Error('nope')));

    mount(<Flags load={load} />);

    await screen.findByText('refused');
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  });

  it('does not refetch because the window regained focus', async () => {
    const load = vi.fn(() => Promise.resolve('loaded'));

    mount(<Flags load={load} />);
    await screen.findByText('loaded');

    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('visibilitychange'));

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  });

  it('gives each mounted tree its own cache', async () => {
    const clients: unknown[] = [];

    function Capture() {
      const client = useQueryClient();

      useEffect(() => {
        clients.push(client);
      }, [client]);

      return null;
    }

    mount(<Capture />);
    mount(<Capture />);

    expect(clients).toHaveLength(2);
    expect(clients[0]).not.toBe(clients[1]);
  });

  it('keeps the same client across re-renders of the tree', async () => {
    const clients: unknown[] = [];

    function Capture({ label }: { label: string }) {
      const client = useQueryClient();

      useEffect(() => {
        clients.push(client);
      }, [client, label]);

      return null;
    }

    const { rerender } = mount(<Capture label="first" />);
    rerender(
      <PlatformQueryProvider>
        <Capture label="second" />
      </PlatformQueryProvider>,
    );

    expect(clients).toHaveLength(2);
    expect(clients[0]).toBe(clients[1]);
  });
});
