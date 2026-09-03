# Canonical skills

Each child directory containing `SKILL.md` is a portable, on-demand procedure.
This is the only repository skill source.

Codex discovers this tree natively. Claude loads skills from here as
configured in `CLAUDE.md` and referenced via `.claude/skills`. Never copy
a `SKILL.md` body into `.claude/` or `.codex/`.

Add a skill only for a reusable procedure with clear triggers and boundaries.
Persistent project facts belong in docs/policies; specialized responsibility
belongs in a role; orchestration belongs in a workflow.
