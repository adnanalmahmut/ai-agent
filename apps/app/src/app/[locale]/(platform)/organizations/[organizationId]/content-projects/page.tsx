import { OrganizationContentProjectsBlock } from '@/features/organization/blocks/organization-content-projects-block';

export default async function OrganizationContentProjectsPage({
  params,
}: {
  params: Promise<{ locale: string; organizationId: string }>;
}) {
  const { organizationId } = await params;
  return <OrganizationContentProjectsBlock key={organizationId} />;
}
