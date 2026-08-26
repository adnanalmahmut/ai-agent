# Move the release artifact actions onto the Node-24 majors

## Goal

Upgrade `actions/upload-artifact` and `actions/download-artifact` to the current
majors, which run on Node 24, without changing any observable property of the
publish -> staging -> production release evidence chain.

The upgrade itself is three lines. The work is proving that the evidence chain
still behaves identically, because these three lines carry the only channel by
which a release's immutable digests reach a deployment.

## Context

GitHub is retiring the Node 20 action runtime. Three call sites still request
it:

| File | Line | Action | Runtime |
| --- | --- | --- | --- |
| `.github/workflows/publish-images.yml` | 88 | `upload-artifact@v4` | node20 |
| `.github/workflows/deploy-staging.yml` | 34 | `download-artifact@v4` | node20 |
| `.github/workflows/deploy-staging.yml` | 111 | `upload-artifact@v4` | node20 |

Declared runtimes were read from each `action.yml` at the tag rather than from
release prose, which proved necessary — the published notes for these
repositories describe v5 as adding Node 24 "support" while the action still
defaults to node20:

- `upload-artifact`: v4 node20, v5 node20, **v6 node24**, v7 node24
- `download-artifact`: v4 node20, v5 node20, v6 node20, **v7 node24**, v8 node24

So the first major that actually runs on Node 24 is upload v6 and download v7,
and the current majors are upload v7 and download v8.

Why this matters more than a typical action bump: the artifact is the trust
boundary between building a release and deploying it. `publish-images.yml`
resolves four image digests, validates them, and uploads `image-digests.json`.
`deploy-staging.yml` downloads that artifact *from another workflow run*, and
everything it deploys is derived from it. `deploy-production.yml` then promotes
only what a staging artifact attests. A silent change in artifact packaging or
path resolution would not fail loudly; it would produce a deployment reading the
wrong file, or a promotion gate that cannot find its evidence.

## Scope

- Repoint the three `uses:` lines to `actions/upload-artifact@v7` and
  `actions/download-artifact@v8`.
- Add `ops/tests/artifact-contract.sh`, covering the handoff and the inputs
  whose defaults must not be relied on silently, and wire it into CI.
  A dedicated file rather than additions to `ops/tests/image-publishing.sh`,
  `ops/tests/staging-cd.sh`, and `ops/tests/production-cd.sh`, which was the
  first intent: every property here spans workflows, so splitting the contract
  across three per-workflow test files would have left no single place where the
  chain is asserted end to end. Those three keep their existing per-workflow
  invariants unchanged.
- Document the pinned majors and the reason the packaging defaults matter.

## Non-goals

- `actions/checkout@v4` and `actions/setup-node@v4` are also Node-20 based.
  Deliberately out of scope. They are ordinary build steps; if one broke, CI
  fails visibly and nothing has been deployed. Mixing them into this change
  would make a release-pipeline diff unreviewable.
- `pnpm/action-setup@v4`, `docker/login-action@v3`, and
  `docker/setup-buildx-action@v3` are untouched.
- No change to the manifest schema, the digest validation expressions, the
  deployment wrapper, or anything on the host.
- No new artifact features. `archive: false` and `skip-decompress: true` exist
  in the target majors and are deliberately not adopted; see Decisions.

## Constraints

- The artifact names `image-digests-<sha>` and `staging-success-<sha>` are a
  cross-workflow contract and must not change. `deploy-production.yml` looks up
  `staging-success-$RELEASE_SHA` by exact name through `gh run download`.
- `run-id: ${{ github.event.workflow_run.id }}` plus `github-token` is what
  makes the cross-run download possible; `permissions: actions: read` must
  remain.
- `pattern: image-digests-*` with `merge-multiple: true` must keep resolving to
  exactly one file at `release/image-digests.json`. The workflow already asserts
  this with `find release -type f -name image-digests.json | wc -l` equal to 1,
  which is the strongest existing guard on the download's behavior.
- `retention-days: 90` and `if-no-files-found: error` must survive.
- Staging must not be operated as part of this change.

## Decisions taken before implementation

- **Target the current majors, not the minimum Node-24 majors.** upload v7 and
  download v8 rather than v6/v7. The intermediate majors are already superseded,
  and landing on the current major avoids doing this twice.
- **Do not adopt `archive: false`** (new in upload v7). It uploads a single file
  unzipped *and ignores the `name` input*, deriving the artifact name from the
  filename instead. That would rename `staging-success-<sha>` to
  `staging-success.json` and break the production promotion lookup outright. The
  default `archive: true` preserves today's behavior exactly.
- **Do not adopt `skip-decompress: true`** (new in download v8). Our artifacts
  are zipped, and the consumer expects extracted files.
- **Accept `digest-mismatch: error`**, the new default in download v8. Earlier
  versions logged a warning and continued when a downloaded artifact's hash did
  not match the server's. Defaulting to a hard failure is strictly better for a
  release pipeline and matches this repository's fail-closed posture. It is
  worth stating explicitly that this is a behavior change we *want*: a corrupted
  digest manifest should stop a deployment, not configure one.
- **Assert the packaging defaults rather than trusting them.** Because two of
  the three defaults above are load-bearing, the tests assert that
  `archive: false` and `skip-decompress: true` are absent, so a future edit that
  adds either has to fail a test rather than a deployment.

## Risks

- **A silent path change is the main risk.** download v5 changed extraction
  paths, but only for single artifacts fetched by `artifact-ids`. We fetch by
  `pattern` with `merge-multiple: true`, which the v5 notes call out as
  explicitly unaffected. The workflow's existing single-file assertion is the
  backstop.
- **Runner floor.** upload v6+ and download v7+ require Actions Runner
  >= 2.327.1. Every job in this repository runs on `ubuntu-latest`; there are no
  self-hosted runners, so this is satisfied. Verified by inspecting every
  `runs-on` in `.github/workflows/`.
- **ESM migration** in upload v7 and download v8 is internal to the actions and
  affects forks, not callers.
- **Untestable-until-merged surface.** The download step only ever executes in
  the real `workflow_run` chain, which cannot be exercised from a pull request.
  Static contract tests plus post-merge observation of the actual publish and
  deploy runs are the only available evidence; the plan says so rather than
  implying CI proves it.

## Rollback and compatibility

Reverting is a one-commit revert of three `uses:` lines and the test additions;
nothing persistent is created and no state migrates. There is no forward or
backward compatibility problem between the two ends of the chain, because a
publish run and its deploy run always execute from the same commit: a publish
run started before the merge is consumed by a deploy run from the same tree.
Artifacts already stored under the old major stay readable — the format is
server-side, not action-version-specific — so an in-flight release spanning the
merge, and the existing 90-day retention window used by production promotion,
are both unaffected.

## Dependencies

- Based on `main` at `d358076`, the PR #39 merge commit. No dependency on other
  open work; nothing else touches these workflows.
- OPS-03 will add retention reporting to `deploy-staging.yml`. Landing this
  first means OPS-03 does not have to debug an artifact-action change and new
  retention logic in the same workflow at once.

## Acceptance criteria

- No workflow requests a Node-20 artifact action.
- Both artifact names, the `pattern`/`merge-multiple`/`run-id`/`github-token`
  download inputs, `retention-days: 90`, and `if-no-files-found: error` are
  unchanged.
- The manifest validation expressions in all three workflows are untouched.
- Contract tests fail if any of the above regresses, and fail if a future edit
  adopts `archive: false` or `skip-decompress: true`.
- No artifact action is named in any workflow's Node-20 deprecation annotation.
  Restated from the dashboard's "no warning remains on final-head CI", which is
  not achievable here — see the section on where the warning appears.
- `ops/tests/*.sh`, `pnpm agents:check`, and the aggregate checks are green
  without `--fix`.
- Final-head CI is green.

## Validation

- `ops/tests/image-publishing.sh`, `ops/tests/staging-cd.sh`,
  `ops/tests/production-cd.sh`, `ops/tests/documentation.sh`
- Mutation probes: revert each `uses:` line to v4 and confirm the new
  assertions fail; add `archive: false` and confirm the guard fires.
- `pnpm agents:check`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`
- Read the Node-20 annotations on the post-merge `Publish immutable images` and
  `Deploy staging` runs and confirm no artifact action is named. CI cannot show
  this either way, because CI uses no artifact actions.

## Required evidence

Command output for each check, the PR URL, the final-head CI conclusion with
per-job results, and the annotation check. Staging is not operated.

## Decision log

- 2026-08-26: Read `runs.using` from `action.yml` at each tag via the GitHub
  API instead of trusting release notes or a summarizer. Two independent web
  summaries of these release pages returned self-contradictory version/date
  tables, and the notes' own wording ("v5 had preliminary support for Node.js
  24, however this action was by default still running on Node.js 20") would
  have led to upgrading to a major that does not solve the problem.

## Where the deprecation warning actually appears

Measured on the runs for `d358076` rather than assumed, by reading the
annotations on each job:

| Workflow | Actions named in the Node-20 annotation |
| --- | --- |
| CI | `checkout@v4`, `setup-node@v4`, `pnpm/action-setup@v4`, `docker/setup-buildx-action@v3` |
| Publish immutable images | `checkout@v4`, **`upload-artifact@v4`**, `docker/login-action@v3`, `docker/setup-buildx-action@v3` |
| Deploy staging | **`download-artifact@v4`**, **`upload-artifact@v4`** |

Two consequences, both worth stating plainly rather than working around.

**CI never used an artifact action at all.** So the acceptance criterion
inherited from the dashboard — "confirm no warning remains on final-head CI" —
cannot be satisfied by this change, and never could have been: every action
named in CI's annotation is one this plan's non-goals exclude. The criterion is
kept but restated truthfully below, as "no artifact action is named in any
deprecation annotation".

**`Deploy staging` is the one workflow this fully clears.** Its annotation names
only the two artifact actions, so after this change it should have no Node-20
annotation at all. `Publish immutable images` will keep its annotation, reduced
to `checkout@v4` and the two `docker/*` actions.

Retiring the rest is a real follow-up, but it belongs in its own change: the
`docker/*` actions gate image publishing, and `setup-node`/`pnpm/action-setup`
gate every build job, so they carry different blast radius and different
evidence needs than an artifact rename.

## Progress

- [x] Determined the actual Node-24 majors from `action.yml` at each tag.
- [x] Confirmed every input in use survives in upload v7 and download v8, by
      enumerating the target `action.yml` inputs.
- [x] Confirmed no self-hosted runners, so the 2.327.1 runner floor is met.
- [x] Established that download v5's path-behavior break does not apply to
      `pattern` + `merge-multiple` downloads.
- [x] Repointed the three call sites; verified by parsing each workflow that
      only the version changed and every input is identical.
- [x] Added `ops/tests/artifact-contract.sh` and wired it into CI.
- [x] Measured which workflows actually carry the annotation, which corrected
      the acceptance criterion rather than the other way round.
- [x] Self-review found three findings in the new test, all repaired:
  1. **Test coverage, medium.** The naming and version assertions were
     independent of whether the artifact steps existed. Deleting the digest
     upload entirely, or duplicating it, passed: the naming greps matched the
     leftover `with:` keys and the version check only constrained references
     still present. A pipeline that had stopped transferring the manifest would
     have gone green. Now each workflow asserts an exact expected count.
  2. **Comment correctness, low.** A comment claimed the `while` loop's
     refusal could not fail the script because it ran in a pipeline subshell,
     and justified a duplicate version-regex recheck on that basis. The claim is
     false — a pipeline's status is its last command's, so `set -e` does abort;
     verified with a standalone probe. Worse, the duplicate encoded the Node-24
     floor a second time as `v[1-5]`/`v[1-6]`, which could drift from the floor
     variables. The loop now reads from a redirected file, so no subshell is
     involved at all, and the floor is stated once.
  3. **Diagnostics, low.** A missing workflow file produced
     `[: Illegal number:` before the real message, because `grep -c` on an
     absent file yields no count. Guarded with a readability check.
- [x] 30 mutation probes across every assertion class, each confirmed to fail
      the suite when applied and to pass when reverted.
- [x] Final-head CI green on `778bf27`: run
      [32964177249](https://github.com/adnanalmahmut/ai-agent/actions/runs/32964177249),
      all five jobs, with `ops/tests/artifact-contract.sh` observed passing.
- [x] Human merge completed 2026-08-26 as
      `a1836e18459dc173155e96a2e929002bf654564a`, and local `main`
      resynchronized from `origin/main` by fast-forward.
- [x] Exercised end to end in the real release chain. See Outcome.

## Outcome

Delivered as [#40](https://github.com/adnanalmahmut/ai-agent/pull/40), merged
2026-08-26 as `a1836e18459dc173155e96a2e929002bf654564a`.

### The untestable surface was exercised, and it worked

This plan's stated risk was that the cross-run download could not be exercised
from a pull request, so the static contract plus post-merge observation were the
only available evidence. The post-merge chain on the merge commit closes that
gap:

- CI
  [32966427951](https://github.com/adnanalmahmut/ai-agent/actions/runs/32966427951)
  success.
- Publish immutable images
  [32966915336](https://github.com/adnanalmahmut/ai-agent/actions/runs/32966915336)
  success: `actions/upload-artifact@v7` executed, and the immutable release
  digests were recorded and uploaded.
- Deploy staging
  [32967241121](https://github.com/adnanalmahmut/ai-agent/actions/runs/32967241121)
  success: `Download publish digest manifest` succeeded on
  `actions/download-artifact@v8`, followed by immutable release metadata
  validation, migration-gated deployment, restricted host health verification,
  external HTTPS smoke tests, and the staging evidence upload.

Both new majors are therefore proven on the live path. Every property the
static contract asserts — the artifact names, the run-id scoping, the pattern
and `merge-multiple` resolution, and the archived packaging both consumers
depend on — held in a real release.

### The annotation prediction was checked, not assumed

Predicted before the merge, then verified after:

| Workflow | Before | After |
| --- | --- | --- |
| Deploy staging | `download-artifact@v4`, `upload-artifact@v4` | **no annotation at all** |
| Publish immutable images | `checkout@v4`, `upload-artifact@v4`, `login-action@v3`, `setup-buildx-action@v3` | `checkout@v4`, `login-action@v3`, `setup-buildx-action@v3` |
| CI | `checkout@v4`, `setup-node@v4`, `pnpm/action-setup@v4`, `setup-buildx-action@v3` | unchanged |

No artifact action is named anywhere in the pipeline's Node-20 annotations. The
one workflow whose annotation named only artifact actions is now fully clear.

### What this deliberately did not fix

The Node-20 deprecation is not retired repository-wide. `checkout@v4`,
`setup-node@v4`, `pnpm/action-setup@v4`, `docker/login-action@v3`, and
`docker/setup-buildx-action@v3` still target it and are still force-run on Node
24 by the runner. That was the stated non-goal, and the annotation table above
is the honest record of what remains rather than a claim of completion.

The most useful thing this plan produced beyond the upgrade is the correction
of its own acceptance criterion: measuring where the annotation actually
appeared showed that "no warning remains on final-head CI" was unachievable by
an artifact-only change, because CI never used an artifact action. Restating the
criterion was the right move; ticking it as written would have been false.

Actions remain pinned to mutable major tags rather than commit SHAs. Raised
during review and deliberately left alone, since it is the convention for every
action here; it stays open as a repository-wide policy question.

## Blockers

None. This plan is complete.
