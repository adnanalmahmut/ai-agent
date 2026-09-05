# Git and delivery policy

- Work on a feature branch; never push directly to `main`.
- Never force-push, rewrite `main`, merge a PR, or enable auto-merge.
- Stage explicit reviewed paths and keep commits/PRs focused.
- Base a PR on `main` by default. Stack only when a real code/data/API
  dependency exists; sequential execution is not a dependency. A stacked PR names
  its dependency and uses the parent head branch as base. After the parent
  merges, retarget the child to `main` and re-verify its diff and mergeability.
- Keep every PR independently reviewable.
- A PR is verified only when CI for its exact current head SHA is green. An
  earlier green SHA proves nothing about the head under review. GitHub is the
  authority on PR and check state; the repository keeps no second copy of it.
- PR descriptions include Goal, What changed, Architecture impact, Validation,
  Risks/tradeoffs, Dependency, and Follow-up work.
- Leave every PR open for human review. Merging to `main` is not administrative:
  it publishes immutable images and automatically deploys live Staging.
- Production promotion remains dormant until operator provisioning. Agents may
  validate its code and docs but must not dispatch it.
