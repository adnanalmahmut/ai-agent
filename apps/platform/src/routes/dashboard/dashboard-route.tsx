import { useLoaderData } from 'react-router';

import { DashboardBlock } from '@/features/dashboard/dashboard-block';
import type { OrganizationsListData } from '@/features/organization/loaders';

export function DashboardRoute() {
  return <DashboardBlock data={useLoaderData<OrganizationsListData>()} />;
}
