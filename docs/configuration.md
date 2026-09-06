# Runtime configuration

Configuration belongs to four boundaries:

| Boundary             | Source of truth                                             | May contain live secrets in Git? |
| -------------------- | ----------------------------------------------------------- | -------------------------------- |
| Build/tooling        | package manifests and `docker-bake.hcl`                     | No                               |
| Local/test           | `apps/control-plane/.env.example`, CI fixtures, Compose defaults  | Only explicit throwaway values   |
| Deployment transport | GitHub Staging Environment variables and restricted SSH key | No runtime secrets               |
| VPS runtime          | root-owned `/etc/ai-agent/runtime.env` (`0600`)             | Never committed or exposed       |

Production configuration does not exist because Production is not provisioned.
See [deployment state](deployment-state.md).

Backend environment values are parsed with Zod in
`apps/control-plane/src/infrastructure/config/*.config.ts`. Missing or invalid
active-provider values stop the relevant process at startup. The names-only VPS
template is `ops/environments/runtime.env.example`; preflight checks values
without printing them.

Compose uses explicit per-service environment allowlists. It does not use
`env_file`, so the worker and migration process do not inherit API-only
credentials. Each frontend separates server-only and browser-safe settings
under `src/config`; `NEXT_PUBLIC_*` values are compiled into an image and
must not contain secrets.

## Control-plane values

| Kind               | Storage                   | Change model                        |
| ------------------ | ------------------------- | ----------------------------------- |
| Bootstrap          | VPS runtime environment   | operator change and process restart |
| Runtime setting    | registered PostgreSQL row | immediate, schema-validated         |
| Managed secret     | encrypted PostgreSQL row  | immediate, metadata readable        |
| Versioned behavior | code-owned definition     | new version and deployment          |

Database connectivity and the key used to decrypt database values remain
bootstrap configuration. Agent instructions, schemas, grants, and model policy
remain versioned code so work already accepted cannot change meaning.

Runtime settings must be registered with a schema, default, sensitivity, and
numeric bounds where applicable. Unknown keys cannot be written.

Managed secrets use AES-256-GCM under a versioned keyring. No read surface
returns plaintext or a masked derivative, and adapters receive plaintext
directly rather than through `process.env`. The active key version is required.
Older keys may be configured as decrypt-only entries while rows are migrated.
Changing the active key does not re-encrypt stored values; use the
[managed-secret rotation procedure](operations-runbook.md#managed-secret-key-rotation)
before retiring an older key.

When adding a backend environment name, update the validating config, example
file, Compose allowlist, relevant tests, and this document if ownership changes.
Never diagnose configuration by dumping an environment or reading the live
runtime file.
