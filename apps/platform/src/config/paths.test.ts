import { describe, expect, it } from 'vitest';

import { API_BASE_PATH, PLATFORM_BASE_PATH } from './paths';

/**
 * The mount path is a deployment contract shared by the Next configuration,
 * the proxy, the API prefix and the reverse proxy in front of them. Nothing in
 * the type system connects the constant to the value Next is actually built
 * with, so this test reads the resolved configuration and compares them.
 */
describe('the platform mount path', () => {
  it('is the basePath Next is built with', async () => {
    const { default: config } = await import('../../next.config');

    expect(config.basePath).toBe(PLATFORM_BASE_PATH);
  });

  it('is a single rooted segment, so a rewrite can strip it', () => {
    expect(PLATFORM_BASE_PATH).toMatch(/^\/[a-z0-9-]+$/);
    expect(API_BASE_PATH).toMatch(/^\/[a-z0-9-]+$/);
  });
});
