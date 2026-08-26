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
- Extend `ops/tests/image-publishing.sh`, `ops/tests/staging-cd.sh`, and
  `ops/tests/production-cd.sh` with contract assertions covering the artifact
  handoff and the new inputs whose defaults must not be relied on silently.
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
- `ops/tests/*.sh`, `pnpm agents:check`, and the aggregate checks are green
  without `--fix`.
- Final-head CI is green.

## Validation

- `ops/tests/image-publishing.sh`, `ops/tests/staging-cd.sh`,
  `ops/tests/production-cd.sh`, `ops/tests/documentation.sh`
- Mutation probes: revert each `uses:` line to v4 and confirm the new
  assertions fail; add `archive: false` and confirm the guard fires.
- `pnpm agents:check`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`
- Confirm no artifact-action deprecation annotation on the final-head run.

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

## Progress

- [x] Determined the actual Node-24 majors from `action.yml` at each tag.
- [x] Confirmed every input in use survives in upload v7 and download v8, by
      enumerating the target `action.yml` inputs.
- [x] Confirmed no self-hosted runners, so the 2.327.1 runner floor is met.
- [x] Established that download v5's path-behavior break does not apply to
      `pattern` + `merge-multiple` downloads.

## Blockers

None currently.
