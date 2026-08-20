# Frontend applications

`apps/web` is the public Next.js 16 application at `/`. It uses App Router,
localized routes, server/public configuration separation, theme support, and a
Better Auth client. Its production image is Next standalone output running as a
non-root user.

`apps/platform` is a React 19 + Vite application mounted at `/platform/`. It
contains authentication, account settings, active-session location, global
administration, organization membership/invitations, and permission-gated UI.
Client permission gates improve UX; backend authorization remains decisive.
The production image serves static files with unprivileged Nginx.

Both applications use the shared `@repo/ui` and `@repo/i18n-core` packages.
English and Arabic messages are parity-tested. CI runs Web lint/test/build and
Platform workspace typecheck/lint/tests/build independently.
