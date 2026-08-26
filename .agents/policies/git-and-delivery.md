# Git and delivery policy

- Work on a feature branch; never push directly to `main`.
- Never force-push, rewrite `main`, merge a PR, or enable auto-merge.
- Stage explicit reviewed paths and keep commits/PRs focused.
- A stacked PR names its dependency and uses the previous head branch as base.
  Stack only when a real code/data/API dependency exists; sequential execution is
  not a dependency. Two PRs sharing an ancestor are siblings, and neither depends
  on the other. See [the PR train workflow](../workflows/pr-train.md) for the
  bounded multi-PR contract, its size limits, and the resume behavior.
- PR descriptions include Goal, What changed, Architecture impact, Validation,
  Risks/tradeoffs, Dependency, and Follow-up work.
- Leave every PR open for human review. Merging to `main` is not administrative:
  it publishes immutable images and automatically deploys live Staging.
- Production promotion remains dormant until operator provisioning. Agents may
  validate its code and docs but must not dispatch it.
