import {
  adminClient,
  inferAdditionalFields,
  organizationClient,
} from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

import { AUTH_BASE_PATH } from '@/config/paths';
import {
  globalAccessControl,
  globalRoles,
  organizationAccessControl,
  organizationRoles,
} from '@/features/authorization/permissions';

export const authClient = createAuthClient({
  baseURL: new URL(
    AUTH_BASE_PATH,
    typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
  ).toString(),
  plugins: [
    inferAdditionalFields({
      user: {
        preferredLanguage: { type: 'string', required: false },
      },
    }),
    adminClient({ ac: globalAccessControl, roles: globalRoles }),
    organizationClient({
      ac: organizationAccessControl,
      roles: organizationRoles,
    }),
  ],
});
