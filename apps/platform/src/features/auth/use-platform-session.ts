import { useRouteLoaderData } from 'react-router';

import { PROTECTED_ROUTE_ID } from './loaders';
import type { PlatformSession } from './session-types';

/**
 * The session, read from the route that already fetched it.
 *
 * Every private page sits under the protected route, whose loader has a
 * confirmed session in hand before any of them render — so this is a lookup,
 * not a request. Calling `authClient.useSession()` in a component instead
 * would issue a second round trip for an answer the router is already holding,
 * and would briefly report `null` while it was in flight.
 *
 * The type parameter is an assertion, not a proof — library mode has no
 * generated route-type map to derive it from. The `undefined` branch is what
 * keeps it honest: it fires only if this hook is used outside the protected
 * tree, which is a wiring mistake and should say so loudly rather than render
 * a page with a blank name on it.
 */
export function usePlatformSession(): PlatformSession {
  const data = useRouteLoaderData<PlatformSession>(PROTECTED_ROUTE_ID);

  if (!data) {
    throw new Error(
      'usePlatformSession was called outside the protected route tree',
    );
  }

  return data;
}
