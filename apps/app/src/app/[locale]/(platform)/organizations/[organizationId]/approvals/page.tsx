import { OrganizationApprovalsBlock } from '@/features/organization/blocks/organization-approvals-block';

export default async function OrganizationApprovalsPage({
  params,
}: {
  params: Promise<{ locale: string; organizationId: string }>;
}) {
  const { organizationId } = await params;
  return <OrganizationApprovalsBlock key={organizationId} />;
}
