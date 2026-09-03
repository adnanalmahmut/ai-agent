import { OrganizationSettingsBlock } from '@/features/organization/blocks/organization-settings-block';
import { getOrganizationBusinessProfileData } from '@/features/organization/server-data';

export default async function OrganizationSettingsPage({
  params,
}: {
  params: Promise<{ locale: string; organizationId: string }>;
}) {
  const { organizationId } = await params;
  const businessProfile = await getOrganizationBusinessProfileData(organizationId);
  return <OrganizationSettingsBlock businessProfile={businessProfile} />;
}
