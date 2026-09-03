import { OrganizationsBlock } from '@/features/organization/blocks/organizations-block';
import { getOrganizationsData } from '@/features/organization/server-data';

export default async function OrganizationsPage() {
  return <OrganizationsBlock data={await getOrganizationsData()} />;
}
