import createMiddleware from 'next-intl/middleware';

import { routing } from '@/i18n/routing';

/**
 * Next.js 16 renamed the `middleware` file convention to `proxy`.
 * See node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md
 */
export default createMiddleware(routing);

export const config = {
  /**
   * Run on every pathname except:
   * - `/api` and `/trpc`      — API surface, never locale-prefixed
   * - `/_next` and `/_vercel` — framework and platform internals
   * - anything with a dot     — static assets (favicon.ico, /*.svg in public/)
   */
  matcher: '/((?!api|trpc|_next|_vercel|.*\\..*).*)',
};
