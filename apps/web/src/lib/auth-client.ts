import { adminClient, organizationClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

import { publicConfig } from '@/config/public';

export const authClient = createAuthClient({
  baseURL: publicConfig.apiUrl,
  plugins: [adminClient(), organizationClient()],
});
