import { Loader2 } from 'lucide-react';

/**
 * What fills the page while the router is still deciding what goes there.
 *
 * Shown on the very first load, before any route element exists: the session
 * check and the route's own chunk are both in flight, and without this the
 * reader looks at an empty document. Subsequent navigations never reach it —
 * React Router keeps the current page on screen until the next one is ready.
 *
 * Deliberately wordless. It appears before the locale route has resolved, so
 * there is no dictionary yet and any sentence here would have to be in one
 * language. A spinner says the same thing in every language, and the label
 * assistive technology needs is carried by `aria-busy` on a live region rather
 * than by copy that could only be English.
 */
export function RouteFallback() {
  return (
    <div
      className="flex min-h-screen items-center justify-center bg-background"
      role="status"
      aria-busy="true"
    >
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
    </div>
  );
}
