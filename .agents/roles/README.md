# Agent roles

These files are the canonical role contracts for every supported agent tool. Tool-specific files under `.codex/agents`, `.claude/agents`, and `.cursor/agents` are thin adapters and must point back here.

| Role | Use it for |
| --- | --- |
| [explorer](explorer.md) | Read-only repository discovery and evidence gathering |
| [implementer](implementer.md) | Small, scoped code and documentation changes |
| [code reviewer](code-reviewer.md) | Correctness, regression, and maintainability review |
| [debugger](debugger.md) | Reproducing and isolating failures |
| [test engineer](test-engineer.md) | Test design, implementation, and validation |
| [security reviewer](security-reviewer.md) | Threat-focused review and high-confidence findings |
| [docs researcher](docs-researcher.md) | Current primary-source documentation research |

The parent agent owns task decomposition, accepts or rejects results, and remains responsible for the final answer.
