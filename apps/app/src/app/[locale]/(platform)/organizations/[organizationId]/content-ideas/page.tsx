import { OrganizationContentIdeasBlock } from '@/features/organization/blocks/organization-content-ideas-block';

export default async function OrganizationContentIdeasPage({
  params,
}: {
  params: Promise<{ locale: string; organizationId: string }>;
}) {
  const { organizationId } = await params;
  return <OrganizationContentIdeasBlock key={organizationId} />;
}
