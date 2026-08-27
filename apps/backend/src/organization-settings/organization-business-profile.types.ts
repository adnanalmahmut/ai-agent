import { SUPPORTED_LOCALES, type AppLocale } from '@repo/i18n-core';
import { z } from 'zod';

const supportedCurrencies = new Set(
  (
    Intl as typeof Intl & {
      supportedValuesOf(key: 'currency'): string[];
    }
  ).supportedValuesOf('currency'),
);

const nullableText = (maximum: number) =>
  z
    .string()
    .trim()
    .max(maximum)
    .transform((value) => (value.length === 0 ? null : value))
    .nullable();

const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(isIanaTimezone)
  .transform(canonicalTimezone);

const currencySchema = z
  .string()
  .trim()
  .length(3)
  .transform((value) => value.toUpperCase())
  .refine((value) => supportedCurrencies.has(value));

const websiteUrlSchema = z
  .string()
  .trim()
  .max(2_048)
  .transform((value) => (value.length === 0 ? null : value))
  .nullable()
  .refine((value) => value === null || isHttpUrl(value));

/** Strict replacement contract owned by the application, never Better Auth. */
export const replaceOrganizationBusinessProfileSchema = z
  .object({
    version: z.number().int().positive(),
    locale: z.enum(SUPPORTED_LOCALES),
    timezone: timezoneSchema,
    currency: currencySchema,
    legalName: nullableText(200),
    industry: nullableText(120),
    websiteUrl: websiteUrlSchema,
    businessDescription: nullableText(2_000),
  })
  .strict();

export type ReplaceOrganizationBusinessProfile = z.infer<
  typeof replaceOrganizationBusinessProfileSchema
>;

export type OrganizationBusinessProfile = {
  organizationId: string;
  version: number;
  locale: AppLocale;
  timezone: string;
  currency: string;
  legalName: string | null;
  industry: string | null;
  websiteUrl: string | null;
  businessDescription: string | null;
  updatedAt: Date;
};

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
