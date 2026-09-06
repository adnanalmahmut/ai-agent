# @repo/api-client

The boundary between this repository's applications and its API. It knows how
to talk to the API; it does not know what any application wants to say.

```sh
pnpm api:types        # regenerate src/generated from the backend's document
pnpm api:types:check  # the merge gate: regenerate and prove nothing drifted
pnpm --filter @repo/api-client typecheck
```

## Entries

| import | what it is |
| --- | --- |
| `@repo/api-client` | the wire protocol for a response and its errors, plus `ApiError` and `ApiUnavailableError` |
| `@repo/api-client/browser` | `createBrowserTransport({ basePath })` — same-origin, credentialed |
| `@repo/api-client/server` | `createServerTransport({ origin, basePath })` — cross-origin, cookie passed in, uncached |
| `@repo/api-client/generated` | the generated OpenAPI `paths`, `operations` and `components` |

The two transports are separate subpaths on purpose. Cookie forwarding and
anything that reads an incoming request belong to the server side, and the
split is what keeps them out of a browser bundle. The server transport is a
framework-agnostic primitive: it is *handed* a cookie rather than reaching for
`next/headers`, so reading the request stays the application's job and this
package stays usable by an application that is not Next.

`apps/platform/src/lib/api/api-client-boundary.test.ts` walks the import graph
from each entry and fails if the public or browser entry can reach a
server-only module — a grep would only see whether a file mentions one.

## Configuration

Nothing is read from the environment or from an application's config module.
Base path and origin are passed to the factories by the caller, because an
application's routing is the application's business.

## Generated types

`src/generated/application-api.generated.ts` is the single copy in this
repository. It is produced from the backend's Zod-authored OpenAPI document
through `scripts/generate-api-types.mjs`, which builds the backend, emits the
document to a temporary file, and runs `openapi-typescript` over it — no
database, no Redis, no running API, no credentials.
