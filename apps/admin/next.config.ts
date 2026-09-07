import createNextIntlPlugin from 'next-intl/plugin';
import type { NextConfig } from 'next';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const withNextIntl = createNextIntlPlugin();
const appDirectory = dirname(fileURLToPath(import.meta.url));

/**
 * No `basePath`. This surface is served from its own origin rather than from
 * a path on somebody else's, and which origin that is belongs to the secure
 * origin work rather than here.
 *
 * No rewrites either. Better Auth is reached through the route handler at
 * `src/app/api/auth/[...all]`, which reads `ADMIN_API_ORIGIN` per request, so
 * development, the standalone server and the container all take the same path
 * and none of them has the Control Plane's address compiled into it.
 */
const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: join(appDirectory, '../..'),
  transpilePackages: ['@repo/ui'],
};

export default withNextIntl(nextConfig);
