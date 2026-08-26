# Host bundle versioning and deployment preflight hardening

## Goal

Make it impossible for a release to reach `prisma migrate deploy` on a host
that cannot run it. The host bundle becomes a versioned, verifiable artifact;
every application release declares the minimum bundle version it requires; and
the deploy path refuses — before migrations — when the host cannot satisfy the
release.

## Context

`main` at `b50b0f7` deployed to Staging only after four manual repairs, none of
which CI could have caught, because none of them are properties of the
repository. The full account is in
[`../completed/application-control-plane-and-first-agent.md`](../completed/application-control-plane-and-first-agent.md);
the mechanism behind all four is the same.

Verified against source during discovery rather than assumed:

- `ops/lightsail/ai-agent-deploy` checks only that the compose file,
  `runtime.env`, and the preflight script *exist*. It never checks what they
  are. A compose file from an earlier release satisfies every one of those
  checks.
- `ops/lightsail/bootstrap-host.sh` installs the host scripts once, at host
  creation, and then prints `operator must now install root-owned runtime.env,
  compose bundle, Nginx site, and certificate`. There is no supported way to
  *update* an installed bundle, and nothing records which version is installed.
- Nothing in a release states which host it needs. `image-digests.json` carries
  the repository, the source SHA, the publish run, and four image digests — no
  host requirement of any kind.
- The deploy sequence reaches `compose run --rm migrate` after
  `compose up -d --wait postgres redis geoipupdate` and never inspects the
  database's capabilities. `CREATE EXTENSION vector` in
  `20260823010000_knowledge_rag_core` is the first thing that discovers the
  image is wrong, and it discovers it from inside the migration container.
- `ops/runtime-preflight.sh` validates fifteen required keys and the shape of
  `APP_ENCRYPTION_KEY`. The list is hand-maintained and has no relationship to
  what `docker-compose.yml` actually interpolates, so a new required variable
  can ship without ever being added to it.
- Neither the deploy script nor the preflight checks free disk. Image
  extraction on the smallest Lightsail plans is the operation most likely to
  exhaust it, and it fails there as an opaque Docker error.
- `ops/lightsail/bootstrap-host.sh` contains its swap-provisioning block twice,
  verbatim, including the comment.

## Scope

One pull request, `fix/ops-host-bundle-preflight`:

- A versioned host bundle: `ops/host-bundle/VERSION`, a declared file
  inventory, an installer that records what it installed, and a preflight that
  verifies the recorded inventory still matches what is on disk.
- Release-side declaration: every published image carries the release SHA and
  the minimum host-bundle version as OCI labels, and
  `image-digests.json` records the same minimum.
- Host-side enforcement in `ai-agent-deploy`, all of it before migrations:
  bundle integrity, free disk, runtime environment, image labels against the
  installed bundle version, compose resolving exactly the pinned digests, and
  PostgreSQL extension availability.
- Contract tests in CI that lock the parts which drift silently: the preflight
  required-key list against the compose file's empty-default variables, and the
  deploy script's required-extension list against the migrations.
- Documentation for the bundle, the operator update procedure, and the new
  refusal messages.
- The local-only resume harness (`.agents/scripts/resume-task.mjs`,
  `pnpm agents:resume`) that this program's handoffs depend on.

## Non-goals

No image retention or pruning policy, no backup/restore drill, and no
disk-pressure observability — those are OPS-03. No GitHub Actions artifact
action upgrades — that is OPS-02. No Production provisioning: Production
remains unprovisioned and must not be operated. No change to the SSH command
grammar, no new capability reachable over the CI deploy key, and no new
mechanism that reads `/etc/ai-agent/runtime.env` outside the existing
`--env-file` and preflight paths.

## Constraints

- The dispatcher's `ForcedCommand` grammar is the trust boundary for the CI
  deploy key. It stays exactly as wide as it is; the release's host requirement
  must therefore travel inside the images, not as a new SSH argument.
- Host scripts are POSIX `sh` and run as root under `sudo -n`. No path they use
  may be overridable from the environment, so tests rewrite absolute paths the
  way `ops/tests/release-manifest.sh` already does.
- Migrations are forward-only and deployment-gated. Every new check must fail
  *before* `compose run --rm migrate`, never between migrations and boot.
- No check may print a secret value. Presence, shape, and non-secret identity
  only.
- Rollback must keep working. `rollback` runs the same `deploy_release` path
  with `no-migrate`, so every new refusal applies to it too and must be
  satisfiable by a release that already ran.

## Decisions taken before implementation

- **The release declares its host requirement through image labels, not the SSH
  command.** Extending the dispatcher's grammar would put the requirement
  outside the artifact it describes, and — worse — an old dispatcher would
  reject the new command shape outright, forcing every host into lockstep with
  every release. A label travels with the immutable digest, is readable after
  `compose pull` and before migrations, and lets an older bundle keep serving
  releases whose minimum it already satisfies.
- **Two version numbers, not one.** `ops/host-bundle/VERSION` is what the
  bundle in this repository *is*; `ops/host-bundle/MIN_VERSION` is the oldest
  installed bundle a release built from this tree will tolerate. Collapsing
  them into one would make every cosmetic change to a host script a forced
  host update.
- **The required-key contract is checked in CI, not on the host.** Deriving the
  required set from the installed compose file at deploy time would mean
  parsing YAML interpolation in POSIX `sh`, as root, on the release path. The
  drift it would catch is a property of the repository, so `ops/tests/` catches
  it where `docker compose config` and `jq` already exist, and the host keeps
  an explicit list.
- **The bundle manifest records SHA-256 per installed file.** Recording only a
  version would let a hand-edited host file keep claiming a version it no
  longer matches, which is precisely the Staging failure mode.

## Acceptance criteria

- A host whose recorded bundle version is below the release's declared minimum
  refuses the deployment, with a non-zero exit, before any migration runs.
- A host whose installed compose file or deploy script no longer matches its
  recorded hash refuses the deployment before any migration runs.
- A PostgreSQL image without the `vector` extension available refuses the
  deployment before any migration runs.
- A `runtime.env` missing any required key, or carrying the compose fallback
  database password, refuses the deployment before any migration runs.
- Insufficient free disk refuses the deployment before images are pulled.
- A release whose four image labels disagree with the requested SHA, or with
  each other, refuses the deployment before any migration runs.
- Adding a compose variable with an empty default, or a `CREATE EXTENSION` to a
  migration, fails CI until the corresponding host-side list is updated.
- `rollback` continues to redeploy the previous release without migrations.

## Validation

- `ops/tests/host-bundle.sh` (new), `ops/tests/runtime-preflight.sh`,
  `ops/tests/release-manifest.sh`, `ops/tests/lightsail-boundary.sh`,
  `ops/tests/image-publishing.sh`, `ops/tests/staging-cd.sh`,
  `ops/tests/production-cd.sh`, `ops/tests/documentation.sh`
- `docker compose --profile staging --profile migration config`
- `docker buildx bake --file docker-bake.hcl release --print`
- `pnpm agents:check`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`

## Required evidence

Command output for each check above, the PR URL, and the final-head CI
conclusion. Staging is not to be operated as part of this change: the bundle
installer is delivered and documented, and installing it on the live host is a
human operator action taken after merge.

## Decision log

- 2026-08-26: `ops/tests/host-bundle.sh` installs the bundle into a sandbox with
  the real installer and then drives the deploy wrapper that installer put
  there, rather than a rewritten copy of the repository file. A test that
  rewrites the script under test proves the script; this one proves the
  recorded manifest too, which is the part that failed on Staging.
- 2026-08-26: Every new gate and every drift check was mutation-probed —
  removed, the suite fails; restored, it passes. A refusal that no test can
  make fail is indistinguishable from no refusal at all.
- 2026-08-26: The completed control-plane plan was moved to `completed/` with
  landing evidence for PR4–PR7 and the hardening remediation. Its `Progress`
  section had claimed PR4 in progress and PR5–PR7 unstarted while all five were
  merged, which made the tracked plan disagree with `main` — the plan is the
  authority the dashboard defers to, so a stale one is worse than none.

## Progress

- [x] Discovery against installed source: deploy script, dispatcher grammar,
  bootstrap host script, both preflights, compose interpolation defaults,
  bake targets, all four workflows, and the existing `ops/tests/` harness
  patterns.
- [x] Local `main` verified equal to `origin/main` at `b50b0f7`; inherited
  working-tree work inspected and preserved.
- [x] Completed plan reconciled and moved to `completed/`; this plan created.
- [x] Versioned host bundle: `ops/host-bundle/{VERSION,MIN_VERSION,files}`,
  `ops/lightsail/install-host-bundle.sh`, and the recorded
  `/etc/ai-agent/host-bundle.manifest` verified by `ops/host-preflight.sh`.
  `bootstrap-host.sh` now delegates to the installer instead of listing the
  same `install` commands, and its duplicated swap block is gone.
- [x] Release-side declaration: `io.ai-agent.release.sha` and
  `io.ai-agent.host-bundle.min-version` on every image in the release set, the
  publish workflow exporting `MIN_VERSION` into Bake, `hostBundleMinVersion` in
  `image-digests.json` at `schemaVersion` 2, and both deploy workflows refusing
  a manifest without it.
- [x] Host-side refusals, all before `compose run --rm migrate`: bundle
  integrity, free space, runtime environment, image labels against the recorded
  bundle version, `compose config --images` against the pinned digests, and
  PostgreSQL extension availability.
- [x] `ops/tests/host-bundle.sh` reproduces all four Staging failures against
  the installed bundle, and locks the two contracts that drift silently.
  `ops/tests/{runtime-preflight,release-manifest,deploy-service-health,lightsail-boundary,documentation}.sh`
  updated; the new test runs in CI's container-topology step.
- [x] Documentation synchronized: new `docs/host-bundle.md`, plus
  `docs/{README,deployment,cd,rollback,operations-runbook,troubleshooting}.md`,
  `ops/{container-foundation,staging-deployment}.md`, and
  `ops/lightsail/README.md`.
- [x] Local verification: every `ops/tests/*.sh`, `pnpm agents:check`,
  `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, and
  `docker buildx bake --print`. Mutation probes confirmed each new gate and each
  drift check fails when removed.
- [ ] Review, remediation, and final-head CI

## Blockers

None currently.
