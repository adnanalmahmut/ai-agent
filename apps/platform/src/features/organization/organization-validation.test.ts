import { describe, expect, it } from 'vitest';

import { validate } from '@/features/auth/validation';

import {
  ORGANIZATION_SLUG_MAX_LENGTH,
  createOrganizationSchema,
  inviteMemberSchema,
  organizationBusinessProfileSchema,
  suggestSlug,
  updateOrganizationSchema,
} from './organization-validation';

const issues = (input: unknown) => {
  const parsed = validate(createOrganizationSchema, input);
  return parsed.ok ? {} : parsed.issues;
};

describe('creating an organization', () => {
  it('accepts a plain name and slug', () => {
    const parsed = validate(createOrganizationSchema, {
      name: 'Acme Research',
      slug: 'acme-research',
    });

    expect(parsed.ok).toBe(true);
  });

  it('reports issues as translation keys, never as sentences', () => {
    // A schema that returned English would be an untranslatable string living
    // in a validation module.
    expect(issues({ name: '', slug: '' })).toEqual({
      name: 'organizationNameRequired',
      slug: 'organizationSlugRequired',
    });
  });

  it.each([
    ['Acme Research', 'organizationSlugInvalid'],
    ['-leading', 'organizationSlugInvalid'],
    ['trailing-', 'organizationSlugInvalid'],
    ['double--hyphen', 'organizationSlugInvalid'],
    ['under_score', 'organizationSlugInvalid'],
    ['أبحاث', 'organizationSlugInvalid'],
    ['ab', 'organizationSlugTooShort'],
  ])('rejects the slug %s', (slug, expected) => {
    expect(issues({ name: 'Acme', slug }).slug).toBe(expected);
  });

  it('accepts digits and single hyphens', () => {
    expect(
      issues({ name: 'Acme', slug: 'acme-2026-labs' }).slug,
    ).toBeUndefined();
  });

  it('lowercases a slug rather than rejecting the case', () => {
    const parsed = validate(createOrganizationSchema, {
      name: 'Acme',
      slug: 'ACME-RESEARCH',
    });

    expect(parsed.ok && parsed.values.slug).toBe('acme-research');
  });

  it('trims a name before measuring it', () => {
    expect(issues({ name: '  A  ', slug: 'acme' }).name).toBe(
      'organizationNameTooShort',
    );
  });

  it('rejects an over-long slug', () => {
    const slug = 'a'.repeat(ORGANIZATION_SLUG_MAX_LENGTH + 1);

    expect(issues({ name: 'Acme', slug }).slug).toBe('organizationSlugTooLong');
  });
});

describe('validating organization business defaults', () => {
  const valid = () => ({
    version: 1,
    locale: 'ar',
    timezone: 'UTC',
    currency: 'USD',
    legalName: '',
    industry: '',
    websiteUrl: '',
    businessDescription: '',
  });

  it('normalizes identifiers and empty optional fields', () => {
    const parsed = validate(organizationBusinessProfileSchema, {
      ...valid(),
      timezone: 'europe/istanbul',
      currency: 'try',
    });

    expect(parsed.ok && parsed.values).toMatchObject({
      timezone: 'Europe/Istanbul',
      currency: 'TRY',
      legalName: null,
      websiteUrl: null,
    });
  });

  it.each([
    ['locale', { locale: 'fr' }, 'businessLocaleInvalid'],
    ['timezone', { timezone: 'Mars/Olympus' }, 'businessTimezoneInvalid'],
    ['currency', { currency: 'ZZZ' }, 'businessCurrencyInvalid'],
    [
      'websiteUrl',
      { websiteUrl: 'javascript:alert(1)' },
      'businessWebsiteInvalid',
    ],
  ] as const)(
    'returns a translation key for an invalid %s',
    (field, changed, issue) => {
      const parsed = validate(organizationBusinessProfileSchema, {
        ...valid(),
        ...changed,
      });

      expect(parsed.ok).toBe(false);
      expect(parsed.ok === false && parsed.issues[field]).toBe(issue);
    },
  );
});

describe('updating an organization', () => {
  it('applies the same rules as creating one', () => {
    // Two schemas rather than one alias, because the two forms could diverge —
    // but until they do, an address that was valid to create must stay valid.
    expect(
      validate(updateOrganizationSchema, {
        name: 'Acme Research',
        slug: 'acme-research',
      }).ok,
    ).toBe(true);

    const parsed = validate(updateOrganizationSchema, {
      name: 'Acme',
      slug: 'Not A Slug',
    });

    expect(parsed.ok).toBe(false);
  });
});

describe('inviting a member', () => {
  it('validates the address', () => {
    const parsed = validate(inviteMemberSchema, { email: 'nope' });

    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.issues.email).toBe('emailInvalid');
  });

  it('does not validate the role', () => {
    // The role comes from a select built out of the role catalogue, so it
    // arrives already narrowed. A rule here would guard a value no path can
    // violate — and would hand the invite call a `string`.
    expect(Object.keys(inviteMemberSchema.shape)).toEqual(['email']);
  });
});

describe('suggesting a slug', () => {
  it.each([
    ['Acme Research', 'acme-research'],
    ['  Acme   Research  ', 'acme-research'],
    ['Acme & Co.', 'acme-co'],
    ['Acme 2026', 'acme-2026'],
  ])('%s → %s', (name, expected) => {
    expect(suggestSlug(name)).toBe(expected);
  });

  it('suggests nothing for a name in a non-Latin script', () => {
    // Transliterated noise would be worse than an empty field: the reader can
    // see an empty field and choose.
    expect(suggestSlug('أبحاث أكمي')).toBe('');
  });

  it('never suggests something its own schema would reject', () => {
    const names = ['Acme Research', 'Acme & Co.', '  A  B  ', 'a'.repeat(200)];

    for (const name of names) {
      const slug = suggestSlug(name);
      if (slug.length === 0) continue;

      expect(
        validate(createOrganizationSchema, { name: 'Valid name', slug }).ok,
        slug,
      ).toBe(true);
    }
  });
});
