# Tool-neutral agent harness

`.agents/` is the semantic source of truth shared by Codex, Claude Code, and
Cursor. Tool directories contain only discovery/configuration adapters and must
not acquire independent copies of policies, role prompts, workflows, hook
logic, or skill bodies.

## Layout

- `policies/`: durable engineering, safety, and delivery invariants
- `roles/`: specialized responsibility contracts
- `workflows/`: explicit orchestration graphs and stopping conditions
- `skills/`: portable procedures loaded on demand
- `hooks/`: deterministic cross-platform enforcement code
- `scripts/`: harness validation, the PR-train state model, and resume
- `task-brief.md`: standard input contract for substantial tasks

Progressive disclosure is deliberate: `AGENTS.md` routes startup context;
focused docs explain the system; a selected workflow/role narrows the task;
skills load only when relevant; source/runtime evidence resolves the remainder.

## Adapter rules

- Codex consumes root/nested `AGENTS.md` and `.agents/skills` directly.
- Claude imports `AGENTS.md` from `CLAUDE.md` and loads canonical skills from
  `.agents/skills/` referenced via `.claude/skills`.
- Custom-agent adapters instruct the spawned tool agent to read exactly one
  canonical role contract before acting.
- Hook configs call Node scripts in `.agents/hooks/`; no executable hook logic
  lives under a tool directory.

## Skill path reference

`.claude/skills` indicates the canonical `.agents/skills` directory
(`../.agents/skills`), while Claude Code is configured via `CLAUDE.md` to depend
on canonical skills directly from `.agents/skills/`.

## Session state

A session that produces several pull requests runs as a bounded PR train.
`.agents/scripts/pr-train.mjs` is the pure state model — parsing, the state
machine, the size limit, dependency and sibling derivation, and reconciliation
against real evidence. `.agents/scripts/resume-task.mjs` is the read-only
integration boundary behind `pnpm agents:resume`.

The contract lives in one place: [the PR train workflow](workflows/pr-train.md).
Other documents route to it rather than restating it.

## Validation

Run `pnpm agents:check` after changing canonical guidance, roles, workflows,
skills, hook policy, the PR-train model, or any tool adapter. The same command is
a dedicated CI job and includes the portable hook-policy regression tests and the
PR-train parser/state tests with their mutation probes.
