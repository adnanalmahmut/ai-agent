import { OrganizationContentProjectBlock } from '@/features/organization/blocks/organization-content-project-block';

export default async function OrganizationContentProjectPage({
  params,
}: {
  params: Promise<{
    locale: string;
    organizationId: string;
    projectId: string;
  }>;
}) {
  const { organizationId, projectId } = await params;
  return (
    <OrganizationContentProjectBlock
      key={`${organizationId}:${projectId}`}
      projectId={projectId}
    />
  );
}
