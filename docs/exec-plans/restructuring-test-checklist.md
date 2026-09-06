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

`isTest()` is `NODE_ENV === 'test' || TEST` truthy. The application never sets
`advanced.disableOriginCheck`, so the guard is on in production and off under
the e2e harness, which sets `NODE_ENV=test` in `test/support/setup-env.ts`.

The Phase A reproduction therefore measured the e2e environment. Re-running the
same reproduction with `NODE_ENV=production` and no other change:

| Trigger | Test environment | Production environment |
| --- | --- | --- |
| `POST /api/auth/sign-up/email` with a foreign `callbackURL` | `200`, link redirects to the attacker | `403 INVALID_CALLBACK_URL`, no mail sent |
| `POST /api/auth/request-password-reset` with a foreign `redirectTo` | `200`, link redirects to the attacker with the token | `403 INVALID_REDIRECT_URL`, no mail sent |

So the deployed exposure was narrower than the Phase A entry implies: upstream
protected it. What was genuinely absent was any configuration of our own
pinning that behavior, and any test able to prove it — the suite that exercises
these flows had the control silently disabled.

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
