import { DashboardBlock } from '@/features/dashboard/dashboard-block';
import { getOrganizationsData } from '@/features/organization/server-data';

export default async function DashboardPage() {
  return <DashboardBlock data={await getOrganizationsData()} />;
}
