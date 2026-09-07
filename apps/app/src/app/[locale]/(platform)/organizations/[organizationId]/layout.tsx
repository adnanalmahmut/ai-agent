import { OrganizationShellBlock } from '@/features/organization/blocks/organization-shell-block';
import { getOrganizationData } from '@/features/organization/server-data';
import type { ReactNode } from 'react';

export default async function OrganizationLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string; organizationId: string }>;
}) {
  const { organizationId } = await params;
  const data = await getOrganizationData(organizationId);
  return <OrganizationShellBlock data={data}>{children}</OrganizationShellBlock>;
}
