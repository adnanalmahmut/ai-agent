# Restructuring characterization checklist

The suite to re-run after every extraction in the restructuring, and the record
of which behavior each part of it protects. Companion to
[the migration baseline](restructuring-baseline.md).

The point is not coverage in general. It is that a behavior the migration must
preserve has a test that fails if the move breaks it.

## Re-runnable set

```sh
# Isolated local services (postgres-test :5433, redis-test :6378)
docker compose --profile test up -d postgres-test redis-test
pnpm --filter backend run db:deploy

pnpm --filter backend test        # unit
pnpm --filter backend test:e2e    # e2e
pnpm --filter platform test       # platform unit
```

Narrow re-runs while iterating:

```sh
pnpm --filter backend test:e2e -- --testPathPatterns 'agent-run|agent-execution-claim'
pnpm --filter backend test:e2e -- --testPathPatterns 'agent-run-reconciliation'
pnpm --filter backend test:e2e -- --testPathPatterns 'platform/auth'
pnpm --filter backend test:e2e -- --testPathPatterns 'mcp-tool-adapter'
pnpm --filter backend test:e2e -- --testPathPatterns 'agent-action-approval|tool-execution'
pnpm --filter backend test:e2e -- --testPathPatterns 'knowledge-isolation'
pnpm --filter backend test:e2e -- --testPathPatterns 'platform/outbox'
```

## Gap matrix

Assessed against the baseline commit. "Existing" means the behavior already had
a test that would fail if a move broke it; those were left alone rather than
duplicated.

| Behavior to preserve | Existing test | Gap | Added | Run |
| --- | --- | --- | --- | --- |
| Business row and its outbox event commit or roll back together | `test/e2e/ai/agent-run.e2e-spec.ts` — commits atomically / rolls back both | none | — | `--testPathPatterns 'ai/agent-run'` |
| A repeated idempotency key yields one logical run | `test/e2e/ai/agent-run.e2e-spec.ts` — concurrent and sequential retries; key reuse across organizations | none | — | `--testPathPatterns 'ai/agent-run'` |
| A stale attempt cannot settle a newer one | `test/e2e/ai/agent-execution-claim.e2e-spec.ts` — superseded-attempt writes rejected; terminal run not reopened | none | — | `--testPathPatterns 'agent-execution-claim'` |
| The organization in the path is the authority scope | `content-ideas`, `content-projects`, `organization`, `knowledge-isolation`, `agent-action-approval` e2e | none | — | `--testPathPatterns 'features/|platform/organization'` |
| Organization roles grant no platform authority, and the reverse | `test/e2e/platform/organization.e2e-spec.ts` — separation from global RBAC; `admin-rbac` | none | — | `--testPathPatterns 'platform/organization|admin-rbac'` |
| No external effect before approval | `test/e2e/ai/agent-action-approval.e2e-spec.ts`; `mcp-tool-adapter` — can only propose, reaches no provider | none | — | `--testPathPatterns 'agent-action-approval'` |
| Authority is rechecked at delivery, not only at decision | `agent-action-approval.e2e-spec.ts` — recipient who moved organizations; organization archived after approval | none | — | `--testPathPatterns 'agent-action-approval'` |
| An ambiguous attempt records `OUTCOME_UNKNOWN`, never `FAILED` | `test/unit/workers/handlers/side-effect-execution.handler.spec.ts`; `agent-action-approval.e2e-spec.ts` | none | — | `--testPathPatterns 'agent-action-approval'` |
| `proposal` / `awaiting_approval` stays the current shape | `mcp-tool-adapter.e2e-spec.ts`; `test/unit/features/agent-management/tools/notification-send.tool.spec.ts` | none | — | `--testPathPatterns 'mcp-tool-adapter'` |
| An expired MCP session is refused on its next exchange | `mcp-tool-adapter.e2e-spec.ts` — closes an expired session and refuses the exchange | none | — | `--testPathPatterns 'mcp-tool-adapter'` |
| A session belongs to its opener and its organization | `mcp-tool-adapter.e2e-spec.ts` — who may drive a session | none | — | `--testPathPatterns 'mcp-tool-adapter'` |
| **An abandoned session is swept without any client request, and releases the organization's in-flight ceiling** | reconciler unit spec only, against a fake `AgentRunService` | no database-level proof, and the capacity consequence untested anywhere | **4 tests** in `test/e2e/ai/agent-run-reconciliation.e2e-spec.ts` — "an abandoned MCP session" | `--testPathPatterns 'agent-run-reconciliation'` |
| The outbox survives crash, lease lapse, and unknown event types | `test/e2e/platform/outbox.e2e-spec.ts` | none | — | `--testPathPatterns 'platform/outbox'` |
| Verification, reset, and invitation mail reach the right address | `test/e2e/platform/auth.e2e-spec.ts`; `test/unit/infrastructure/auth/auth-mail.spec.ts` | none | — | `--testPathPatterns 'platform/auth'` |
| The invitation URL is built from configuration, not the request | `auth-mail.spec.ts` — builds the accept URL from configuration | none | — | `pnpm --filter backend test` |
| No token or action URL in logs | `auth.e2e-spec.ts` — log safety | none | — | `--testPathPatterns 'platform/auth'` |
| **The verification and reset link origin is server configuration, not request input** | asserted for invitations only; verification and reset receive their URL from Better Auth | the two request-triggered links were unpinned | **3 tests** in `test/e2e/platform/auth.e2e-spec.ts` — "security mail is addressed by configuration, not by the request" | `--testPathPatterns 'platform/auth'` |

Fixtures reuse `test/support/agent-run-fixtures.ts` and the harness already in
each spec. No new fixture files, no provider is contacted, and no test sleeps
for a fixed interval.

## Pre-existing defect found while characterizing — FIXED

**Unvalidated redirect after following a security-mail link, leaking the
password-reset token.**

Status: **FIXED** in `fix(auth): restrict security-mail redirects to trusted
destinations`. The record below is kept as written so it stays clear that the
defect was pre-existing rather than introduced by the restructuring; the
root cause and the resolution follow it.

- Reproduced on the baseline commit `c03a3ad6d65477932827f7265cfda7da9c0b6aaa`.
  The backend source at the head of this change is byte-identical to that
  commit, so this is pre-existing and not a regression from this work.
- Where: `apps/backend/src/infrastructure/auth/auth.factory.ts` passes
  `trustedOrigins` to Better Auth (`better-auth ^1.6.27`), and
  `BETTER_AUTH_TRUSTED_ORIGINS` parses correctly into an array of URLs
  (`infrastructure/config/auth.config.ts`). The caller-supplied `callbackURL`
  on sign-up and `redirectTo` on password reset are nevertheless honoured
  without being checked against that list.
- Expected: following an emailed link redirects only to a trusted origin, and a
  reset token never crosses to a foreign one.
- Actual, observed against the isolated local stack with
  `BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:3000,http://localhost:3001`:

  | Trigger | Following the emailed link |
  | --- | --- |
  | `POST /api/auth/sign-up/email` with `callbackURL: https://attacker.example/steal` | `302` → `https://attacker.example/steal` (no session cookie set) |
  | `POST /api/auth/request-password-reset` with `redirectTo: https://attacker.example/steal` | `302` → `https://attacker.example/steal?token=<reset token>` |

- Impact: `request-password-reset` is unauthenticated and takes both the victim
  address and the redirect target. The mail arrives from the real service at
  the victim's real address; clicking it hands a valid reset token to the
  attacker's origin. That is an account-takeover path, not only an open
  redirect.
- Not fixed in Phase A. Phase A is characterization, and a change to
  authentication redirect handling needs its own review. No test in that change
  asserted the observed behavior as correct.

### Root cause

Better Auth does validate `callbackURL` and `redirectTo` against
`trustedOrigins`, in `originCheckMiddleware` and in the per-endpoint
`originCheck` guard. Both consult `context.skipOriginCheck`, which
`better-auth@1.6.27` derives as:

```js
// node_modules/better-auth/dist/context/create-context.mjs
skipOriginCheck: options.advanced?.disableOriginCheck !== void 0
  ? options.advanced.disableOriginCheck
  : isTest() ? true : false
```

`isTest()` is `NODE_ENV === 'test' || TEST` truthy. At the time of this
finding the application did not set `advanced.disableOriginCheck`, so the guard
was on in production and off under the e2e harness, which sets `NODE_ENV=test`
in `test/support/setup-env.ts`. That divergence has since been closed — see
[Origin and CSRF protection is pinned on](#origin-and-csrf-protection-is-pinned-on)
below — so the fallback no longer decides anything for this application.

The Phase A reproduction therefore measured the e2e environment. Re-running the
same reproduction with `NODE_ENV=production` and no other change:

| Trigger | Test environment | Production environment |
| --- | --- | --- |
| `POST /api/auth/sign-up/email` with a foreign `callbackURL` | `200`, link redirects to the attacker | `403 INVALID_CALLBACK_URL`, no mail sent |
| `POST /api/auth/request-password-reset` with a foreign `redirectTo` | `200`, link redirects to the attacker with the token | `403 INVALID_REDIRECT_URL`, no mail sent |

So the deployed exposure was narrower than the Phase A entry implies: upstream
protected it. What was genuinely absent was any configuration of our own
pinning that behavior, and any test able to prove it — the suite that exercised
these flows had the control silently disabled. Both gaps are now closed.

### Behavior after the fix

The mailed link's return destination is now built by the server from
`APP_PLATFORM_URL` plus a known route, in
`infrastructure/auth/auth-mail.ts`. The caller's `callbackURL` / `redirectTo`
is overwritten before the mail is composed, so it cannot reach the link in any
environment, whatever `skipOriginCheck` happens to be. Better Auth's own route
and token are left untouched.

| Flow | Destination now baked into the mailed link |
| --- | --- |
| Email verification (sign-up and resend) | `${APP_PLATFORM_URL}/${locale}/verify-email?status=verified` |
| Password reset | `${APP_PLATFORM_URL}/${locale}/reset-password` |

`locale` is the server-resolved outbound locale already used to pick the email
language — stored preference, `X-App-Locale`, cookie, then `Accept-Language` —
never a caller-supplied origin.

Upstream's `trustedOrigins` check is unchanged and still rejects a foreign
`callbackURL` outright in production. The two layers are independent.

### Regression coverage

- `test/e2e/platform/auth.e2e-spec.ts`, `security mail returns only to a
  server-decided destination`: fetches the real link out of the captured mail
  and follows it with `redirects(0)`, asserting the `Location`. Eleven hostile
  destination shapes are exercised against password reset and against
  verification resend, plus sign-up: a plainly foreign origin, a host that only
  ends with the trusted one, userinfo hiding the real host, a protocol-relative
  authority, a backslash-confused authority, a foreign port, a scheme swap,
  percent- and double-encoded origins, a non-http scheme, and a newline-smuggled
  origin. The reset cases additionally assert the token is present on the
  platform origin and that the attacker host appears nowhere in the mail or the
  redirect.
- The same file keeps the legitimate paths: a reset completed end to end
  through the mailed link, and a sign-up verification that still sets
  `emailVerified`.
- `test/unit/infrastructure/auth/auth-mail.spec.ts` pins the overwrite for both
  flows and that the route and token Better Auth chose survive it.

All 24 of these assertions fail against the unfixed callbacks and pass with
them, so the coverage is known to detect the defect rather than merely
accompany the fix.

## Origin and CSRF protection is pinned on

`apps/backend/src/infrastructure/auth/auth.factory.ts` sets both
`advanced.disableOriginCheck: false` and `advanced.disableCSRFCheck: false`
explicitly. Better Auth only falls back to `isTest() ? true : false` for the
first when the option is absent, and only couples CSRF to that fallback while
the second is absent, so stating both means `development`, `test`, `staging`
and `production` all make the same decision and only the trusted-origin list
differs. Both are literals: deriving either from `NODE_ENV` would reintroduce
the divergence they remove.

In the installed `better-auth@1.6.27`, `context.skipOriginCheck` gates:

- `Origin` / `Referer` validation against `trustedOrigins`, for state-changing
  requests that carry a cookie (`validateOrigin`).
- `callbackURL`, `redirectTo`, `errorCallbackURL` and `newUserCallbackURL`
  validation, both in the router-wide `originCheckMiddleware` and in the
  per-endpoint `originCheck` guard.

`context.skipCSRFCheck` separately gates the CSRF protection on sign-in and
sign-up (`formCsrfMiddleware`), including the cross-site navigation block.
Better Auth would otherwise fold that into `skipOriginCheck` through
`shouldSkipCSRFForBackwardCompat`, a path it documents as deprecated; pinning
`disableCSRFCheck` means the CSRF guarantee no longer depends on the origin
one, and a later change to either cannot quietly move the other.

### What this changed in the suite

Enabling the checks against the unmodified harness failed **441 of 827 tests
across 15 of the 34 e2e suites**, every one of them because a request modelled
a browser without sending what a browser sends. The breadth comes from a single
helper: almost every feature suite reaches Better Auth through `as()` to create
an organization or invite a member before it can test anything else, so one
missing header failed whole suites at setup.

| Suite | Failing tests |
| --- | --- |
| `platform/organization` | 56 |
| `features/content-ideas` | 49 |
| `features/knowledge-management` | 49 |
| `features/content-projects` | 46 |
| `ai/mcp-tool-adapter` | 45 |
| `ai/agent-action-approval` | 44 |
| `features/control-plane` | 33 |
| `features/organization-business-profile` | 27 |
| `features/control-plane-audit` | 27 |
| `ai/tool-execution` | 25 |
| `features/organization-agent-installation` | 15 |
| `features/knowledge-embedding` | 10 |
| `platform/auth` | 8 |
| `platform/super-admin-floor` | 6 |
| `platform/admin-rbac` | 4 |

The fix was to the harness, not to the protection:

- `test/support/auth-harness.ts` — `as()` stands for a signed-in browser, so
  its `post`, `put` and `del` attach `Origin: <APP_PLATFORM_URL origin>`. `get`
  deliberately does not: a browser does not send `Origin` on an ordinary
  same-origin read, and Better Auth's middleware returns early for GET.
  `APP_PLATFORM_URL` and `BETTER_AUTH_TRUSTED_ORIGINS` are independent
  settings, so the harness now asserts at load that the first's origin appears
  in the second and fails with a named error rather than a stray `403`. This
  one helper accounted for all but the eight failures below.
- `test/e2e/platform/auth.e2e-spec.ts` — four cookie-carrying requests built
  directly now send the same header, and three tests that drove a foreign
  destination through a `200` were changed to name a destination on a trusted
  origin, which is what they were actually about. (The eighth followed from one
  of those three.)

Tests that exist to pin missing- or foreign-`Origin` behavior build their
request directly and never go through `as()`.

### Regression coverage

`test/e2e/platform/auth-origin.e2e-spec.ts` pins the behavior against
`/api/auth/update-user`, a cookie-authenticated state-changing route whose
effect is one readable column, so a refusal can be shown to have changed
nothing:

| Origin on the request | Result |
| --- | --- |
| the trusted platform origin | `200`, column written |
| `https://attacker.example` | `403 INVALID_ORIGIN`, column untouched |
| `http://localhost:3001.attacker.example` | `403 INVALID_ORIGIN`, column untouched |
| `http://localhost:3001@attacker.example` | `403 INVALID_ORIGIN`, column untouched |
| the trusted host on another scheme or port | `403 INVALID_ORIGIN`, column untouched |
| absent, or the literal `null` | `403 MISSING_OR_NULL_ORIGIN`, column untouched |

A sign-in from a foreign origin is refused with `403 INVALID_ORIGIN`, sets no
cookie, and leaves the session count unchanged. Security mail is covered as its
own layer: a foreign `redirectTo`, a foreign `callbackURL` on a resend, and a
foreign `callbackURL` at sign-up are each refused before any mail is dispatched,
and the sign-up case creates no account.

Every status code here was read from the installed version rather than assumed.

### The two layers stay independent

1. Better Auth refuses a destination outside `trustedOrigins`.
2. If a destination reaches the mail callbacks anyway, `auth-mail.ts` still
   overwrites it with the server-decided route.

Layer 1 now answers first in every environment, which means the end-to-end
attack cases can no longer reach layer 2. Layer 2 is therefore proven where it
still can be: directly against the callbacks in
`test/unit/infrastructure/auth/auth-mail.spec.ts`, and end to end through a
destination on a *trusted* origin that the product nonetheless did not choose —
which passes layer 1 and is still discarded by layer 2.

Each pin was mutation-tested separately against the 13 tests in
`auth-origin.e2e-spec.ts`:

| Mutation | Result |
| --- | --- |
| remove `disableOriginCheck: false` | 11 failed, 2 passed |
| set `disableCSRFCheck: true` | 8 failed, 5 passed |

Removing the origin pin loses both the `Origin` enforcement and the
destination validation. Disabling CSRF loses only the `Origin` enforcement —
`validateOrigin` returns on `skipCSRFCheck` before it reaches the trusted-origin
comparison — while the three security-mail destination cases still refuse,
which is what shows the two flags now guard different things. In both runs the
two survivors, or five, include the trusted-origin positive cases, which assert
that a legitimate request is carried out and are meant to pass either way.

### `TEST` does not reach the deployed backend

Verified against `docker-compose.yml`, `apps/backend/Dockerfile`,
`ops/environments/runtime.env.example` and `ops/runtime-preflight.sh`: the
backend and worker services list their environment explicitly and use no
`env_file`, so only the named variables are passed, and `TEST` is not among
them. `NODE_ENV` is passed, but the image defaults it to `production` and
`ops/runtime-preflight.sh` refuses to start a host whose `NODE_ENV` does not
match that host's environment. After this change neither variable can turn the
origin or CSRF checks off in a deployed runtime.

## Not tested, and why

- **Provider-side delivery.** No test contacts Resend, SES, or SMTP. The
  transports have unit tests; the e2e suites substitute the transport.
- **Temporal, R2, and the observability stack.** Not installed. There is
  nothing to characterize.
- **The platform UI end to end.** `apps/platform/e2e/` is Playwright and runs
  separately; the migration boundaries in question are backend ones.
- **Where a security-mail link finally lands.** No longer a gap: pinned by the
  regression coverage described above.

## Answered from the baseline's assumption log

Assumption 1, on MCP session cleanup, is settled: `AgentRunReconciler`
(`ai/execution/agent-run-reconciler.service.ts`) sweeps expired sessions on its
own interval without any client request, and the new tests prove it against
PostgreSQL, including the release of the organization's in-flight ceiling. The
baseline entry has been updated. Assumptions 2 through 5 remain open.
