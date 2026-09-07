# Deployment state

| Environment | State                    | Delivery                                                        | Agent boundary                                                                  |
| ----------- | ------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Local/test  | Available                | Developer commands and CI                                       | Repository-local inspection, edits, and tests are allowed.                      |
| Staging     | Provisioned and deployed | Merge to `main` → CI → immutable publish → automatic deployment | Do not operate the VPS, runtime file, GitHub Environment, DNS, TLS, or backups. |
| Production  | Not provisioned          | Workflow and host procedures are inactive                       | Do not provision, configure, deploy, roll back, or operate it.                  |

Repository capability is not evidence of a live environment. Production
workflow, bootstrap, promotion, rollback, and recovery files exist but must not
be invoked without an explicit operator provisioning decision.

## The administrative surface

`apps/admin` is mounted at `/admin` on the staging host, behind a client
allowlist at the gateway, so that the work moving administrative screens onto
it can be tested against a real deployment. It is an optional release
component: its image is published and attested with every release, and only the
staging Compose profile runs it. Production composes no administrative service
and installs no administrative route, and activating it there stays gated on
OP-3 in [security](security.md#op-3--administrative-exposure-gate), whose
strong-authentication requirement is not implemented.

Staging activation is not automatic. A host serves `/admin` only once an
operator has installed the gateway route and written
`/etc/ai-agent/admin-staging-allowed-cidrs`; until then the route either does
not exist or denies every client. No administrative screen has moved: those
operations are still performed through the customer application at
`/platform/admin/*`, authorized per action by the backend.

## Delivery reality

Pull requests run verification only. A successful push-to-`main` CI run
publishes one immutable four-image release set and triggers Staging deployment.
The Production workflow is manual and inactive.

A merge is therefore a live Staging action. Pull requests remain open for human
review.

## Evidence ownership

- Repository: workflow logic, Compose topology, configuration names, host
  scripts, and procedures.
- GitHub: run results and environment-scoped deployment metadata.
- Host: service status, installed bundle, release manifests, runtime values,
  backups, and TLS evidence.

Never copy host values or secrets into the repository or claim an environment
exists from repository files alone.
