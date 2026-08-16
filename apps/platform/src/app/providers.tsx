import type { ReactNode } from 'react';

import { ThemeProvider } from '@/components/theme-provider';

/**
 * Providers that sit above the router.
 *
 * Only the ones that are genuinely global belong here, and after the migration
 * that is one: the colour theme, which is a device preference and has nothing
 * to do with which route is open.
 *
 * The internationalization and direction providers deliberately do *not* live
 * here. They depend on the locale in the URL, which only the router knows, so
 * they are mounted by the locale route — below the router, above everything
 * that reads them.
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </ThemeProvider>
  );
}
