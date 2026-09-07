import { authClient } from '@/features/auth/auth-client';
import { useOptionalOrganizationContext } from '@/features/organization/organization-context';

export type CurrentOrganization = {
  id: string;
  name: string;
};

export function useCurrentOrganization(): CurrentOrganization | null {
  const organizationContext = useOptionalOrganizationContext();

  const active = authClient.useActiveOrganization();

  if (organizationContext) {
    return {
      id: organizationContext.organization.id,
      name: organizationContext.organization.name,
    };
  }

  if (active.data) {
    return { id: active.data.id, name: active.data.name };
  }

  return null;
}
