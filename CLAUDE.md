@AGENTS.md

## Claude Code adapter

Canonical skills are exposed through `.claude/skills/` symlinks to
`.agents/skills/`. Claude-specific agents and hooks are thin adapters; their
behavior remains canonical under `.agents/`.
