'use client';

import { createContext, useContext, type ReactNode } from 'react';

import type { FullOrganization, OrganizationMember } from './organization-types';

export type OrganizationContext = {
  organization: FullOrganization;
  viewer: {
    userId: string;
    member: OrganizationMember | null;
  };
};

const Context = createContext<OrganizationContext | null>(null);

export function OrganizationProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: OrganizationContext;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useOptionalOrganizationContext(): OrganizationContext | null {
  return useContext(Context);
}

export function useOrganizationContext(): OrganizationContext {
  const value = useOptionalOrganizationContext();
  if (!value) {
    throw new Error(
      'useOrganizationContext was called outside an organization route',
    );
  }
  return value;
}
