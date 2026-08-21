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
- `scripts/`: harness validation and maintenance
- `task-brief.md`: standard input contract for substantial tasks

Progressive disclosure is deliberate: `AGENTS.md` routes startup context;
focused docs explain the system; a selected workflow/role narrows the task;
skills load only when relevant; source/runtime evidence resolves the remainder.

## Adapter rules

- Codex and Cursor consume root/nested `AGENTS.md` and `.agents/skills`
  directly.
- Claude imports `AGENTS.md` from `CLAUDE.md` and exposes each canonical skill
  through an officially supported project-skill symlink.
- Custom-agent adapters instruct the spawned tool agent to read exactly one
  canonical role contract before acting.
- Hook configs call Node scripts in `.agents/hooks/`; no executable hook logic
  lives under a tool directory.
- Cursor commands are omitted when a portable skill is the correct abstraction.

## Symlink checkout contract

`.claude/skills/<name>` must remain a symbolic link to the corresponding
`.agents/skills/<name>` directory. WSL and Linux checkouts normally preserve
that contract. Native Windows checkouts must run on a filesystem that supports
symlinks and have Git symlink checkout enabled (for example, configure
`core.symlinks=true` before cloning or re-checking out the repository, with the
required Windows Developer Mode or privilege available).

When `core.symlinks=false`, Git materializes a link as a small regular file
containing only the target path. That is not a supported adapter: do not copy
skill bodies or accept the path-text file. Fix the checkout; the stack's
`pnpm agents:check` validation layer reports this condition explicitly once
that layer is present.

## Validation

Run `pnpm agents:check` after changing canonical guidance, roles, workflows,
skills, hook policy, or any tool adapter. The same command is a dedicated CI
job and includes the portable hook-policy regression tests.
