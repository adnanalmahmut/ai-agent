import createNextIntlPlugin from 'next-intl/plugin';
import type { NextConfig } from 'next';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PLATFORM_BASE_PATH } from './src/config/paths';

const withNextIntl = createNextIntlPlugin();
const appDirectory = dirname(fileURLToPath(import.meta.url));
const developmentApiOrigin = (
  process.env.PLATFORM_API_PROXY_TARGET ?? 'http://127.0.0.1:3002'
).replace(/\/$/, '');

const nextConfig: NextConfig = {
  basePath: PLATFORM_BASE_PATH,
  output: 'standalone',
  outputFileTracingRoot: join(appDirectory, '../..'),
  transpilePackages: ['@repo/ui'],
  async rewrites() {
    if (process.env.NODE_ENV !== 'development') return [];

    return [
      {
        source: '/api/:path*',
        destination: `${developmentApiOrigin}/api/:path*`,
        basePath: false,
      },
    ];
  },
};

export default withNextIntl(nextConfig);
