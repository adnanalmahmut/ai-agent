# Deployment state

This page separates current operational fact from repository capability.

| Environment | Current state | Change path | Agent boundary |
|---|---|---|---|
| Local/test | Available from the repository | Developer commands and CI | Agents may inspect, edit, and test in their assigned checkout. |
| Staging | Provisioned and deployed | Merge to `main` -> CI -> immutable image publish -> automatic Staging deployment | Do not operate the VPS, edit `/etc/ai-agent/runtime.env`, change Environment values, or deploy manually. |
| Production | Not provisioned | Future manual promotion of exact Staging evidence after operator provisioning and approval | Do not provision, configure, deploy, roll back, or otherwise operate Production. |

The repository already contains a target Production workflow, host bootstrap,
promotion contract, rollback contract, and recovery tooling. Those files are
prepared architecture, not evidence that Production infrastructure exists.

## Delivery reality

1. Pull requests run verify-only CI.
2. A merge to `main` runs CI, then publishes one immutable four-image release
   set, then automatically deploys Staging.
3. The Production workflow is `workflow_dispatch` and intentionally dormant
   until Production is provisioned by an operator.

Never merge a pull request merely to test this harness: merging changes live
Staging. PRs remain open for human review.

## Evidence ownership

- Repository truth: workflows, Compose topology, host scripts, configuration
  names, and runbooks.
- GitHub truth: CI/publish/deploy run results and environment-scoped metadata.
- Host truth: service status, release manifests, root-owned runtime values,
  backup artifacts, and TLS/runtime evidence.

Repository documentation must not claim that future Production tooling is
live. Live host values and secrets must never be copied into this repository.
