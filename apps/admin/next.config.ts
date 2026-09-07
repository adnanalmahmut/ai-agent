import createNextIntlPlugin from 'next-intl/plugin';
import type { NextConfig } from 'next';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const withNextIntl = createNextIntlPlugin();
const appDirectory = dirname(fileURLToPath(import.meta.url));
const developmentApiOrigin = (
  process.env.ADMIN_API_PROXY_TARGET ?? 'http://127.0.0.1:3002'
).replace(/\/$/, '');

/**
 * No `basePath`. This surface is served from its own origin rather than from
 * a path on somebody else's, and which origin that is belongs to the secure
 * origin work rather than here.
 */
const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: join(appDirectory, '../..'),
  transpilePackages: ['@repo/ui'],
  async rewrites() {
    if (process.env.NODE_ENV !== 'development') return [];

    return [{ source: '/api/:path*', destination: `${developmentApiOrigin}/api/:path*` }];
  },
};

export default withNextIntl(nextConfig);
