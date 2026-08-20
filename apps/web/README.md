# Web

Public Next.js 16 App Router application, served at `/` behind host Nginx.

```sh
pnpm --filter web dev
pnpm --filter web lint
pnpm --filter web test
pnpm --filter web build
```

Server-only configuration lives under `src/config/server.ts`; browser-safe
configuration is separated in `public.ts`. Localized navigation supports Arabic
and English. Production uses standalone output and runs as a non-root container.
See [`docs/frontend.md`](../../docs/frontend.md) and the root README.
