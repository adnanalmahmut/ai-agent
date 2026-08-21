# Engineering policy

- Establish behavior from source, tests, workflows, and runtime evidence before
  editing. Documentation is a guide, not a substitute for verification.
- Prefer the smallest coherent change. Preserve public contracts unless the
  task explicitly changes them and acceptance criteria cover migration.
- Keep configuration parsed at boundaries and dependencies injected through
  existing composition roots.
- Add meaningful regression coverage for changed behavior; do not write tests
  that merely mirror implementation.
- Validate iteratively and finish with the repository-required aggregate
  checks. Never hide, skip, weaken, or rewrite a failing check to get green.
- Review the final diff for correctness, error handling, security, performance,
  tests, documentation, generated artifacts, and unrelated changes.
- Keep documentation synchronized with behavior and distinguish current state
  from future design.
