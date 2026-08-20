import createNextIntlPlugin from 'next-intl/plugin';
import type { NextConfig } from 'next';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const withNextIntl = createNextIntlPlugin();
const appDirectory = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: join(appDirectory, '../..'),
  transpilePackages: ['@repo/ui'],
};

export default withNextIntl(nextConfig);
