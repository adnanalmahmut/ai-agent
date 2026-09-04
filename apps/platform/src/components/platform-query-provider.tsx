'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

/**
 * The single server-state client for the authenticated platform tree.
 *
 * It is created in state rather than at module scope so that one client
 * belongs to one mounted browser tree. A module-level client would be shared
 * by every server render in the same process, which would let one visitor's
 * responses be read by the next.
 *
 * The defaults restate the behaviour the screens had before there was a query
 * client: one request per mount, no automatic retry, and no background refetch
 * triggered by focusing the window or regaining the network. Control-plane
 * reads are operator-initiated; a tab left open should not keep asking.
 */
export function PlatformQueryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            refetchOnWindowFocus: false,
            refetchOnReconnect: false,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
