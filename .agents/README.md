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
- `scripts/`: harness validation and the read-only resume snapshot
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

The repository owns no workflow state. Git, GitHub PR state, and final-head CI
are authoritative, and a fresh agent reads them directly.

`pnpm agents:resume` (`.agents/scripts/resume-task.mjs`) prints that evidence as
one snapshot after a compaction or restart: branch, HEAD, `origin/main`, status,
recent history, and — when `gh` is available — the branch's PR with its base,
head SHA, mergeability, and the checks for that exact SHA. It observes only: it
never mutates Git, files, or GitHub, and it degrades to local evidence when `gh`
is missing or unauthenticated.

An optional local `TODO.md` is a plain untracked note. Nothing parses it, and it
never overrules Git or GitHub. Multi-PR rules live in
[the Git and delivery policy](policies/git-and-delivery.md).

## Validation

Run `pnpm agents:check` after changing canonical guidance, roles, workflows,
skills, hook policy, harness scripts, or any tool adapter. It validates
mechanical integrity — present canonical files, adapter routing and JSON shape,
Node syntax, skill frontmatter, resolvable Markdown links — and runs the portable
hook-policy and resume regression tests. The same command is a dedicated CI job.
