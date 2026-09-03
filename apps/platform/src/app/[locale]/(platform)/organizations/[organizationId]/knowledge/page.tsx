import { OrganizationKnowledgeBlock } from '@/features/organization/blocks/organization-knowledge-block';

export default async function OrganizationKnowledgePage({
  params,
}: {
  params: Promise<{ locale: string; organizationId: string }>;
}) {
  const { organizationId } = await params;
  return <OrganizationKnowledgeBlock key={organizationId} />;
}
