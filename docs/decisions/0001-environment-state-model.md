# ADR 0001: Separate deployed state from target architecture

- Status: Accepted
- Date: 2026-08-21

## Context

The repository contains complete-looking Production workflows and host tooling,
while only Staging is provisioned. Documentation had treated prepared tooling
as proof of live infrastructure.

## Decision

Documentation and agent guidance must identify each environment as one of:
local/test, currently deployed, or target/future. The canonical current-state
record is `docs/deployment-state.md`. Prepared Production files remain in the
repository but must be described as dormant until operator provisioning.

## Consequences

- Agents may reason about and test Production tooling but may not operate it.
- Merging to `main` is a live Staging action and remains human-owned.
- Harness validation rejects known stale claims that both environments are
  provisioned.
- An operator must update the state record with evidence when Production is
  eventually provisioned.
