'use client';

import { createContext, useContext, type ReactNode } from 'react';

import type { PlatformSession } from './session-types';

const PlatformSessionContext = createContext<PlatformSession | null>(null);

export function PlatformSessionProvider({
  children,
  session,
}: {
  children: ReactNode;
  session: PlatformSession;
}) {
  return (
    <PlatformSessionContext.Provider value={session}>
      {children}
    </PlatformSessionContext.Provider>
  );
}

export function usePlatformSession(): PlatformSession {
  const session = useContext(PlatformSessionContext);
  if (!session) {
    throw new Error(
      'usePlatformSession was called outside the protected route tree',
    );
  }
  return session;
}
