# Runtime configuration

Configuration has four ownership boundaries. Values must remain at their
owning boundary; this repository records names, validation, and flow only.

| Boundary | Source of truth | Examples | Secret values allowed in Git? |
|---|---|---|---|
| Build/tooling | `package.json`, package manifests, `docker-bake.hcl` | Node/pnpm versions, build targets, `VITE_APP_NAME` | No |
| Local/test | `apps/backend/.env.example`, CI job environment, Compose test defaults | throwaway test DB/auth/mail values | Only explicit non-live fixtures |
| GitHub deployment metadata | `staging` Environment variables plus restricted deploy key secret | VPS host/user, pinned host key, public URL | Names/workflow references only |
| VPS runtime | `/etc/ai-agent/runtime.env`, root-owned `0600` | database, Redis, Better Auth, mail, OAuth, MaxMind | Never |

Production Environment values do not currently exist because Production is not
provisioned. The Production workflow documents the future contract only.

## The control plane, and what may not move into it

Most operational values no longer require a deployment to change. They live in
PostgreSQL and are edited by a `super_admin` through the Platform. Four kinds
of value are involved and they are not interchangeable:

| Kind | Where it lives | Changed by | Example |
|---|---|---|---|
| Bootstrap | `/etc/ai-agent/runtime.env` | Operator, then restart | `DATABASE_URL`, `APP_ENCRYPTION_KEY` |
| Dynamic setting | `runtime_setting` row, registered in code | `super_admin`, effective immediately | retrieval chunk limit |
| Managed secret | `managed_secret` row, encrypted | `super_admin`, effective immediately | provider API key |
| Versioned behavior | Code, in a versioned definition | A deployment, as a new version | an agent's prompt |

Bootstrap configuration cannot move. `DATABASE_URL` is what reaches the rows,
and `APP_ENCRYPTION_KEY` is what decrypts them, so storing either beside them
would be circular.

Versioned behavior must not move either, and the reason is subtler than it
looks. A durable `AgentRun` accepted against version 1 must still execute
version 1 when a worker picks it up, possibly after a rollout. A prompt in a
mutable row cannot promise that: editing it silently changes the meaning of work
that was already accepted. Changing behavior publishes a new version.

Between those, a setting qualifies as dynamic only if it is registered in
`apps/backend/src/control-plane/runtime-settings/runtime-setting.registry.ts`
with a Zod schema, a default, a sensitivity, and — for anything numeric —
bounds. An unregistered key cannot be written, so the Platform cannot create a
setting nothing reads, and a value outside its bounds is refused rather than
stored.

Managed secrets are encrypted with AES-256-GCM under `APP_ENCRYPTION_KEY`. No
read surface returns one, not even masked, and none is ever placed into
`process.env` — an adapter receives the plaintext directly at the point of use.
Each row records a fingerprint of the key that sealed it, so rotating
`APP_ENCRYPTION_KEY` makes existing credentials report as unusable and asks the
operator to re-enter them, instead of failing later as an unexplained provider
outage.

## Validation and distribution

- Backend configuration is parsed by Zod in
  `apps/backend/src/config/*.config.ts`; required active-provider settings fail
  at boot.
- `ops/environments/runtime.env.example` is the authoritative names-only VPS
  template. `ops/runtime-preflight.sh` validates it without printing values.
- `docker-compose.yml` uses explicit per-service `environment` allowlists. It
  deliberately does not use `env_file`, so worker and migration containers do
  not inherit API-only credentials.
- Vite `VITE_*` configuration is compiled into the Platform image. It is not a
  runtime secret or a mutable VPS setting.
- Next.js server/public separation lives under `apps/web/src/config/`.

## Ownership rules

- Application/runtime secrets are installed and rotated by the host operator.
- The Staging GitHub Environment owns only deployment transport metadata and
  its restricted SSH key.
- Coding agents must not read, print, modify, or request live runtime values.
- Adding an environment name requires updating the validating config,
  names-only template, Compose allowlist, tests, and this document when
  ownership changes.
- Never solve a configuration problem by dumping an environment or copying a
  live value into logs, issues, commits, prompts, or GitHub variables.
