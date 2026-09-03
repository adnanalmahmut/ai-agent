import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const pages = [
  '[locale]/(platform)/page.tsx',
  '[locale]/(auth)/(guest)/sign-in/page.tsx',
  '[locale]/(auth)/(guest)/sign-up/page.tsx',
  '[locale]/(auth)/verify-email/page.tsx',
  '[locale]/(auth)/forgot-password/page.tsx',
  '[locale]/(auth)/reset-password/page.tsx',
  '[locale]/(auth)/organizations/accept-invitation/page.tsx',
  '[locale]/(platform)/organizations/page.tsx',
  '[locale]/(platform)/organizations/new/page.tsx',
  '[locale]/(platform)/organizations/[organizationId]/page.tsx',
  '[locale]/(platform)/organizations/[organizationId]/members/page.tsx',
  '[locale]/(platform)/organizations/[organizationId]/invitations/page.tsx',
  '[locale]/(platform)/organizations/[organizationId]/knowledge/page.tsx',
  '[locale]/(platform)/organizations/[organizationId]/content-ideas/page.tsx',
  '[locale]/(platform)/organizations/[organizationId]/content-projects/page.tsx',
  '[locale]/(platform)/organizations/[organizationId]/content-projects/[projectId]/page.tsx',
  '[locale]/(platform)/organizations/[organizationId]/approvals/page.tsx',
  '[locale]/(platform)/organizations/[organizationId]/settings/page.tsx',
  '[locale]/(platform)/settings/page.tsx',
  '[locale]/(platform)/admin/users/page.tsx',
  '[locale]/(platform)/admin/control-plane/page.tsx',
  '[locale]/(platform)/design-system/page.tsx',
] as const;

describe('the App Router contract', () => {
  it.each(pages)('declares %s', (page) => {
    expect(existsSync(join(process.cwd(), 'src/app', page))).toBe(true);
  });

  it('places every private page beneath the protected route group', () => {
    const privatePages = pages.filter((page) => page.includes('(platform)'));

    expect(privatePages).toHaveLength(16);
    expect(
      existsSync(join(process.cwd(), 'src/app/[locale]/(platform)/layout.tsx')),
    ).toBe(true);
  });
});
