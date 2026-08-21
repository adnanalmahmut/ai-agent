# Canonical skills

Each child directory containing `SKILL.md` is a portable, on-demand procedure.
This is the only repository skill source.

Codex and Cursor discover this tree natively. Claude discovers per-skill
symlinks under `.claude/skills/`; those links must resolve back here. Never copy
a `SKILL.md` body into `.claude/`, `.codex/`, or `.cursor/`.

Add a skill only for a reusable procedure with clear triggers and boundaries.
Persistent project facts belong in docs/policies; specialized responsibility
belongs in a role; orchestration belongs in a workflow.
