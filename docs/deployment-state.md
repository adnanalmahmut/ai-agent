# Deployment state

| Environment | State                    | Delivery                                                        | Agent boundary                                                                  |
| ----------- | ------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Local/test  | Available                | Developer commands and CI                                       | Repository-local inspection, edits, and tests are allowed.                      |
| Staging     | Provisioned and deployed | Merge to `main` → CI → immutable publish → automatic deployment | Do not operate the VPS, runtime file, GitHub Environment, DNS, TLS, or backups. |
| Production  | Not provisioned          | Workflow and host procedures are inactive                       | Do not provision, configure, deploy, roll back, or operate it.                  |

Repository capability is not evidence of a live environment. Production
workflow, bootstrap, promotion, rollback, and recovery files exist but must not
be invoked without an explicit operator provisioning decision.

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
