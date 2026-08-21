# Safety policy

- Preserve unrelated worktree changes. Stop if an in-scope file has ambiguous
  user edits that cannot be safely retained.
- Ask before destructive commands or operations that make data hard to recover.
- Never print or store secrets, tokens, cookies, session IDs, private keys,
  credentials, or environment dumps.
- Do not read or modify `/etc/ai-agent/runtime.env`, live host configuration,
  GitHub Environment values/secrets, DNS, TLS, or backup destinations.
- Do not connect to or manually deploy Staging. Do not provision or operate
  Production.
- Do not make a service public, broaden proxy trust, bypass authorization,
  disable validation, or weaken CI as a workaround.
- Hooks enforce only deterministic high-confidence boundaries. They must be
  fast, local, testable, non-mutating, and produce actionable failures.
