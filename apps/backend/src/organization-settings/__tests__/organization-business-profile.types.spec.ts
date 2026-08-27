import { describe, expect, it } from '@jest/globals';

import { replaceOrganizationBusinessProfileSchema } from '../organization-business-profile.types';

const valid = () => ({
  version: 1,
  locale: 'ar',
  timezone: 'UTC',
  currency: 'USD',
  legalName: null,
  industry: null,
  websiteUrl: null,
  businessDescription: null,
});

describe('organization business profile contract', () => {
  it('normalizes bounded text, currency, and IANA timezone values', () => {
    const parsed = replaceOrganizationBusinessProfileSchema.parse({
      ...valid(),
      timezone: 'europe/istanbul',
      currency: 'try',
      legalName: '  Acme Limited  ',
      industry: '   ',
      websiteUrl: 'https://example.com/about',
      businessDescription: '  A small research studio.  ',
    });

    expect(parsed).toEqual({
      ...valid(),
      timezone: 'Europe/Istanbul',
      currency: 'TRY',
      legalName: 'Acme Limited',
      industry: null,
      websiteUrl: 'https://example.com/about',
      businessDescription: 'A small research studio.',
    });
  });

  it.each([
    ['locale', { locale: 'fr' }],
    ['timezone', { timezone: 'Mars/Olympus' }],
    ['currency', { currency: 'ZZZ' }],
    ['website protocol', { websiteUrl: 'javascript:alert(1)' }],
    ['version', { version: 0 }],
  ])('refuses an invalid %s', (_name, changed) => {
    expect(
      replaceOrganizationBusinessProfileSchema.safeParse({
        ...valid(),
        ...changed,
      }).success,
    ).toBe(false);
  });

  it('refuses unknown fields instead of persisting metadata by accident', () => {
    expect(
      replaceOrganizationBusinessProfileSchema.safeParse({
        ...valid(),
        providerCredential: 'must-never-be-stored-here',
      }).success,
    ).toBe(false);
  });
});
