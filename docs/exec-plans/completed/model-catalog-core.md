# Code-owned model catalog and effective-dated pricing

## Goal

Deliver MOD-01A as a focused pull request: replace production free-form model
identifiers with stable application identities, describe only the model
capabilities the current application can enforce, and resolve immutable pricing
revisions by effective instant without provider access.

## Context

The deployed product uses exactly two provider models, both from OpenAI:
`gpt-4o-mini` for the code-owned `content-idea@1` AgentDefinition and
`text-embedding-3-small` for knowledge ingestion and retrieval. Today the agent
definition stores a free `provider/model` string and the Mastra adapter parses
its prefix. The embedding adapter owns a separate provider-model constant.
Pricing is not represented at all.

The application, not Mastra or OpenAI's SDK, must own the stable vocabulary and
the operational price history. Provider documentation is evidence for the
initial entries, not an assertion that either capabilities or prices are
timeless.

## Scope

- Add a small code-owned catalog for the two models the current source uses.
- Give each model a stable application identifier, provider identity, exact
  provider model identifier, purpose-specific capabilities, and current adapter
  compatibility.
- Add immutable, effective-dated USD token-price revisions with stable revision
  identities and official-source retrieval metadata.
- Provide deterministic exact lookup by application identity and by exact
  provider/model pair, with no fallback.
- Refuse invalid catalog construction, including duplicate identities,
  unsupported model/pricing combinations, invalid intervals, and overlapping
  pricing revisions.
- Type AgentDefinition model selection as the bounded generation-model identity
  and make the Mastra adapter resolve the provider/model identifier through the
  catalog.
- Source the existing embedding adapter's provider model identifier from the
  same catalog without changing persisted embedding compatibility.
- Add focused Jest coverage and update the narrow owning backend documentation.

## Non-goals

- Organization-specific model policy or selection.
- AgentRun model or pricing pinning; MOD-01B owns both.
- Usage quantity capture, aggregation, ledger entries, billing, or cost math.
- Provider calls, model failover, arbitrary model/provider registration, a UI
  picker, or a generic provider framework.
- Adding models merely because a provider publishes capabilities or pricing.
- Changing the knowledge vector model or its persisted provider-model string.

## Constraints

- Preserve the modular monolith and the existing application-owned runtime
  boundary; Mastra consumes the resolved runtime identifier and never owns
  catalog or pricing policy.
- Catalog lookup and price resolution must be pure and deterministic with no
  live provider dependency.
- Effective intervals are half-open: `effectiveFrom <= T < effectiveTo`, with
  an absent end meaning open-ended. No price is preferable to an ambiguous or
  silently substituted price.
- Store rates as integer USD micros per one million tokens so committed policy
  is exact and this PR does not introduce floating-point cost calculation.
- Treat catalog capabilities as application-enabled policy. Provider support
  not used by a current product boundary does not automatically become enabled.
- Preserve inherited primary-worktree modifications to
  `.agents/workflows/pr-train.md` and `.vscode/settings.json`; they are outside
  this worktree and must never be staged or committed. `TODO.md` remains local.
- Never force-push, merge, enable auto-merge, deploy, or operate Staging.

## Acceptance criteria

- Exact stable-id and exact provider/model lookup return only the declared model.
- Unknown provider, unknown model, and unknown stable identity fail closed; no
  lookup falls back to another or newer model.
- Agent model resolution requires the present Mastra/text/structured-output
  contract and refuses the embedding model.
- Embedding model resolution requires the present text/1536-dimension contract
  and preserves the provider model id already stored on knowledge rows.
- Pricing resolves the one revision effective at an instant, including exact
  start/end boundaries, and refuses missing or ambiguous results.
- Catalog construction refuses overlapping model revisions, duplicate revision
  identities, invalid intervals/rates, and a price for an unknown model.
- Production definitions no longer contain caller/provider free-form model
  strings; Mastra receives the catalog's exact runtime identifier.
- Focused and aggregate checks are green and the final PR head has green CI.

## Validation

Focused iteration:

```sh
pnpm --filter backend test -- model-catalog.spec.ts mastra.runtime.spec.ts worker-composition.spec.ts
pnpm --filter backend typecheck
```

Final local validation:

```sh
pnpm agents:check
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter backend exec node --experimental-vm-modules ./node_modules/jest/bin/jest.js --config ./test/jest-e2e.json --runInBand organization-agent-installation.e2e-spec.ts -t 'refuses caller-selected models'
pnpm build
ops/tests/documentation.sh
git diff --check
```

## Required evidence

- Official OpenAI model and pricing sources, retrieval date, and encoded
  effective dates.
- Focused catalog, runtime-adapter, composition, and boundary-test output.
- Full diff review, independent code/test review findings and remediation.
- Aggregate commands and exact results, final commit SHA, PR URL/base, and
  final-head GitHub Actions result.

## Git / PR policy

- Head `feat/model-catalog-core`, base `main` at
  `4deea359a999a3452f255beab31afb90e36bffe1`.
- Stage only reviewed MOD-01A paths. Push normally and open one PR against
  `main`; leave it open for human review.
- MOD-01B may start from this branch only after this PR is final-head CI green.
- SEC-01A remains an independent sibling from fresh `origin/main`.

## Decision log

- 2026-08-27: The source map justifies exactly two catalog entries: the
  production generation model and the deployed embedding model. No other model
  is added.
- 2026-08-27: Official OpenAI model pages were retrieved for
  `gpt-4o-mini` and `text-embedding-3-small`. The former documents text/image
  input, text and Structured Outputs, a 128,000-token context window, a
  16,384-token output ceiling, and current standard token prices. The latter
  documents text embeddings and the current input-token price.
- 2026-08-27: `gpt-4o-mini` standard pricing begins at the 2024-10-01 prompt
  caching announcement for this catalog because that is the official boundary
  at which all three encoded categories (uncached input, cached input, output)
  are evidenced together. `text-embedding-3-small` begins at its official
  2024-01-25 launch. Earlier instants intentionally resolve no revision.
- 2026-08-27: Provider image input is intentionally omitted from this
  application-capability catalog. The current product accepts bounded JSON/text
  prompts only; recording an unsupported product boundary or adding a second
  provider-capability taxonomy would exceed MOD-01A.
- 2026-08-27: The catalog will be one bounded application service/value module,
  not dynamic registration or a provider plugin mechanism. Synthetic catalogs
  exist only in focused tests to prove invalid combinations are rejected.

## Progress

- [x] Repository, workflow, architecture, existing model boundaries, and tests inspected.
- [x] Current Mastra model-router documentation checked through Context7.
- [x] Official provider capability/pricing evidence checked.
- [x] Minimal design selected and recorded.
- [x] Implementation and remediation-focused tests complete (5 suites / 50 tests green).
- [x] Independent code and test reviews complete; all findings remediated and re-reviewed with no remaining action.
- [x] Aggregate validation green: repository typecheck, lint, unit tests, build, agent harness, documentation checks, and diff check.
- [x] PR #51 open with final-head CI green (run 33069440746), delivered, and merged to main (merge commit 81753e5d38dd946a7c84918d6e2fab469af40166).

## Blockers

None. This plan is complete.
