# Tool-neutral agent harness

`.agents/` is the semantic source of truth shared by Codex, Claude Code, and
Cursor. Tool directories contain only discovery/configuration adapters and must
not acquire independent copies of policies, role prompts, workflows, hook
logic, or skill bodies.

## Layout

- `policies/`: durable invariants —
  [engineering](policies/engineering.md),
  [safety](policies/safety.md),
  [git and delivery](policies/git-and-delivery.md)
- [`roles/`](roles/README.md): specialized responsibility contracts
- [`workflows/`](workflows/README.md): task procedures and stopping conditions
- [`skills/`](skills/README.md): portable procedures loaded on demand
- [`hooks/`](hooks/README.md): deterministic cross-platform enforcement code
- `scripts/`: harness validation and the read-only resume snapshot
- [`task-brief.md`](task-brief.md): standard input contract for substantial tasks

Progressive disclosure is deliberate: `AGENTS.md` routes startup context;
focused docs explain the system; a selected workflow/role narrows the task;
skills load only when relevant; source/runtime evidence resolves the remainder.

## Adapter rules

- Codex consumes root/nested `AGENTS.md` and `.agents/skills` directly.
- Claude imports `AGENTS.md` from `CLAUDE.md` and loads canonical skills from
  `.agents/skills/` referenced via `.claude/skills`.
- Custom-agent adapters instruct the spawned tool agent to read exactly one
  canonical role contract before acting. The role set is whatever
  `roles/` contains: adding one means adding the contract plus an adapter per
  tool, and nothing enumerates the set a second time.
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

Run `pnpm agents:check` after changing canonical guidance, roles, skills, hook
policy, harness scripts, or any tool adapter. It checks mechanical integrity
only: the entry points and hook scripts that executable configuration names,
adapters that route to a role contract that exists, valid hook config wiring,
Node syntax, skill frontmatter, resolvable Markdown links, high-confidence secret
literals, and a consistent deployment record. It runs the portable hook-policy
and resume regression tests alongside those.

It deliberately does not police how an agent document is written — headings,
section counts, or required phrasing. Those are editorial choices, and a
validator that fails the build over them is enforcing a house style rather than
catching a defect.
