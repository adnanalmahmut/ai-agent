import { z } from 'zod';
import { SUPPORTED_LOCALES } from '@repo/i18n-core';

/**
 * Client-side validation for the organization forms.
 *
 * Same contract as the authentication schemas: issues are reported as
 * **translation keys**, never as sentences, and the server re-validates
 * everything. A form that skipped this file entirely would still be safe, just
 * ruder.
 *
 * The slug rules are the interesting part. Better Auth stores a slug as an
 * opaque unique string and imposes no format, so these bounds are *this
 * application's* choice — and they are chosen to match what a slug is for: it
 * appears in URLs and is read aloud. Lowercase letters, digits and single
 * hyphens, not starting or ending with one.
 *
 * Deliberately no reserved-word list. `new` is a real route under
 * `/organizations`, but organization pages are addressed by id rather than by
 * slug precisely so that a slug can never collide with a route — inventing a
 * blocklist here would encode a constraint the router does not actually have.
 */

export const ORGANIZATION_NAME_MIN_LENGTH = 2;
export const ORGANIZATION_NAME_MAX_LENGTH = 100;
export const ORGANIZATION_SLUG_MIN_LENGTH = 3;
export const ORGANIZATION_SLUG_MAX_LENGTH = 48;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const organizationName = z
  .string()
  .trim()
  .min(1, { message: 'organizationNameRequired' })
  .min(ORGANIZATION_NAME_MIN_LENGTH, { message: 'organizationNameTooShort' })
  .max(ORGANIZATION_NAME_MAX_LENGTH, { message: 'organizationNameTooLong' });

const organizationSlug = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, { message: 'organizationSlugRequired' })
  .min(ORGANIZATION_SLUG_MIN_LENGTH, { message: 'organizationSlugTooShort' })
  .max(ORGANIZATION_SLUG_MAX_LENGTH, { message: 'organizationSlugTooLong' })
  .regex(SLUG_PATTERN, { message: 'organizationSlugInvalid' });

export const createOrganizationSchema = z.object({
  name: organizationName,
  slug: organizationSlug,
});

export const updateOrganizationSchema = z.object({
  name: organizationName,
  slug: organizationSlug,
});

/**
 * Only the address is validated.
 *
 * The role is not in this schema on purpose: it comes from a select whose
 * options are the role catalogue, so it arrives already narrowed to a role
 * name and cannot be empty or unknown. A `z.string().min(1)` here would be a
 * rule for a value that no path can violate, and would hand the invite call a
 * `string` where it wants a role.
 */
export const inviteMemberSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, { message: 'emailRequired' })
    .pipe(z.email({ message: 'emailInvalid' })),
});

export type CreateOrganizationValues = z.infer<typeof createOrganizationSchema>;
export type UpdateOrganizationValues = z.infer<typeof updateOrganizationSchema>;
export type InviteMemberValues = z.infer<typeof inviteMemberSchema>;

const supportedCurrencies = new Set(
  (
    Intl as typeof Intl & {
      supportedValuesOf(key: 'currency'): string[];
    }
  ).supportedValuesOf('currency'),
);

const nullableBusinessText = (maximum: number, message: string) =>
  z
    .string()
    .trim()
    .max(maximum, { message })
    .transform((value) => (value.length === 0 ? null : value));

const businessTimezone = z
  .string()
  .trim()
  .min(1, { message: 'businessTimezoneRequired' })
  .max(100, { message: 'businessTimezoneInvalid' })
  .refine(isIanaTimezone, { message: 'businessTimezoneInvalid' })
  .transform(canonicalTimezone);

const businessCurrency = z
  .string()
  .trim()
  .length(3, { message: 'businessCurrencyInvalid' })
  .transform((value) => value.toUpperCase())
  .refine((value) => supportedCurrencies.has(value), {
    message: 'businessCurrencyInvalid',
  });

export const organizationBusinessProfileSchema = z.object({
  version: z.number().int().positive(),
  locale: z.enum(SUPPORTED_LOCALES, { message: 'businessLocaleInvalid' }),
  timezone: businessTimezone,
  currency: businessCurrency,
  legalName: nullableBusinessText(200, 'businessLegalNameTooLong'),
  industry: nullableBusinessText(120, 'businessIndustryTooLong'),
  websiteUrl: nullableBusinessText(2_048, 'businessWebsiteTooLong').refine(
    (value) => value === null || isHttpUrl(value),
    { message: 'businessWebsiteInvalid' },
  ),
  businessDescription: nullableBusinessText(
    2_000,
    'businessDescriptionTooLong',
  ),
});

export type OrganizationBusinessProfileValues = z.infer<
  typeof organizationBusinessProfileSchema
>;

function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function canonicalTimezone(value: string): string {
  return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions()
    .timeZone;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Suggests a slug from a name, as the reader types.
 *
 * A convenience, never a constraint: the field stays editable and the schema
 * above is what decides whether the value is acceptable. Non-Latin names — an
 * Arabic organization name is the normal case here — reduce to an empty
 * suggestion rather than to transliterated noise, which is the honest outcome
 * and leaves the reader to choose their own.
 */
export function suggestSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, ORGANIZATION_SLUG_MAX_LENGTH)
    .replace(/-+$/, '');
}
