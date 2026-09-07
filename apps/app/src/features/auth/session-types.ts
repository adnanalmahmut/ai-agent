import type { AppLocale } from '@repo/i18n-core';

import type { authClient } from './auth-client';

type InferredSession = typeof authClient.$Infer.Session;

export type PlatformUser = InferredSession['user'] & {
  role?: string | null;
  banned?: boolean | null;
  preferredLanguage?: AppLocale | null;
};

export type PlatformSessionRecord = InferredSession['session'] & {
  activeOrganizationId?: string | null;
};

export type PlatformSession = {
  user: PlatformUser;
  session: PlatformSessionRecord;
};

export type OrganizationSummary = {
  id: string;
  name: string;
  slug: string;
  logo?: string | null;
};
