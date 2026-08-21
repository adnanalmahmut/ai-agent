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
