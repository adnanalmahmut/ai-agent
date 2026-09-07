import createNextIntlPlugin from 'next-intl/plugin';
import type { NextConfig } from 'next';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ADMIN_BASE_PATH } from './src/config/paths';

const withNextIntl = createNextIntlPlugin();
const appDirectory = dirname(fileURLToPath(import.meta.url));

/**
 * `basePath`, because the gateway serves this application at a path on the
 * deployment's single hostname rather than on an origin of its own. The
 * alternative — stripping the prefix in Nginx — would leave the application
 * emitting root-relative asset and route URLs that collide with the public
 * site's, and no amount of response rewriting makes that correct.
 *
 * No rewrites. Better Auth is reached through the route handler at
 * `src/app/api/auth/[...all]`, which reads `ADMIN_API_ORIGIN` per request, so
 * development, the standalone server and the container all take the same path
 * and none of them has the Control Plane's address compiled into it.
 */
const nextConfig: NextConfig = {
  basePath: ADMIN_BASE_PATH,
  output: 'standalone',
  outputFileTracingRoot: join(appDirectory, '../..'),
  transpilePackages: ['@repo/ui'],
};

export default withNextIntl(nextConfig);
