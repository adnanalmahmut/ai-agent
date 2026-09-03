@AGENTS.md

## Claude Code adapter

Skills are located in and loaded from `.agents/skills/` (`/home/adnan/code/projects/ai-agents/.agents/skills`).
The path file `.claude/skills` indicates this canonical location (`../.agents/skills`).
Claude-specific agents and hooks are thin adapters; their behavior remains
canonical under `.agents/`.
