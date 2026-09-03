import { screen } from '@testing-library/react';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render';

vi.mock('@/i18n/navigation', async () => import('@/test/navigation-stub'));

const { resetNavigationStub, stubLocation } =
  await import('@/test/navigation-stub');
const { OrganizationTabs } = await import('./organization-tabs');
const { ORGANIZATION_ROUTES } = await import('@/features/auth/routes');

const ORGANIZATION_ID = 'org_acme';

afterEach(resetNavigationStub);

const hrefsOf = () =>
  screen.getAllByRole('link').map((link) => link.getAttribute('href'));

const currentHref = () =>
  screen
    .getAllByRole('link')
    .filter((link) => link.getAttribute('aria-current') === 'page')
    .map((link) => link.getAttribute('href'));

function organizationChildPaths(): Set<string> {
  const routeRoot = join(
    process.cwd(),
    'src/app/[locale]/(platform)/organizations/[organizationId]',
  );
  const found = new Set<string>();

  if (existsSync(join(routeRoot, 'page.tsx'))) found.add('');
  for (const entry of readdirSync(routeRoot, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      existsSync(join(routeRoot, entry.name, 'page.tsx'))
    ) {
      found.add(entry.name);
    }
  }
  return found;
}

describe('the organization tabs', () => {
  it('links only to segments the route tree declares', () => {
    const declared = organizationChildPaths();

    expect(declared.size).toBeGreaterThan(0);

    for (const [name, build] of Object.entries(ORGANIZATION_ROUTES)) {
      const segment = build(ORGANIZATION_ID).split('/').slice(3).join('/');

      expect(
        declared.has(segment),
        `${name} points at "${segment}", which no route declares`,
      ).toBe(true);
    }
  });

  it('renders no link outside the declared organization routes', () => {
    renderWithProviders(<OrganizationTabs organizationId={ORGANIZATION_ID} />);

    const declared = Object.values(ORGANIZATION_ROUTES).map(
      (build) => `/en${build(ORGANIZATION_ID)}`,
    );

    for (const href of hrefsOf()) {
      expect(
        declared,
        `${href} is not a declared organization route`,
      ).toContain(href);
    }
  });

  it('offers a tab for every organization route', () => {
    renderWithProviders(<OrganizationTabs organizationId={ORGANIZATION_ID} />);

    for (const [name, build] of Object.entries(ORGANIZATION_ROUTES)) {
      expect(hrefsOf(), `no tab links to ${name}`).toContain(
        `/en${build(ORGANIZATION_ID)}`,
      );
    }
  });

  describe('the current tab', () => {
    it('is the deepest match, not the overview it sits under', () => {
      stubLocation(ORGANIZATION_ROUTES.contentIdeas(ORGANIZATION_ID));

      renderWithProviders(
        <OrganizationTabs organizationId={ORGANIZATION_ID} />,
      );

      expect(currentHref()).toEqual([
        `/en${ORGANIZATION_ROUTES.contentIdeas(ORGANIZATION_ID)}`,
      ]);
    });

    it('is the overview when that is where the reader is', () => {
      stubLocation(ORGANIZATION_ROUTES.overview(ORGANIZATION_ID));

      renderWithProviders(
        <OrganizationTabs organizationId={ORGANIZATION_ID} />,
      );

      expect(currentHref()).toEqual([
        `/en${ORGANIZATION_ROUTES.overview(ORGANIZATION_ID)}`,
      ]);
    });

    it('marks a nested path under the tab that owns it', () => {
      stubLocation(`${ORGANIZATION_ROUTES.members(ORGANIZATION_ID)}/someone`);

      renderWithProviders(
        <OrganizationTabs organizationId={ORGANIZATION_ID} />,
      );

      expect(currentHref()).toEqual([
        `/en${ORGANIZATION_ROUTES.members(ORGANIZATION_ID)}`,
      ]);
    });
  });
});
