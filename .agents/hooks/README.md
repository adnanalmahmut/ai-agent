# Portable agent hooks

The executable policy lives here; native tool files only register it. The hooks are deterministic, repository-local, and do not access the network.

## Events

| Event | Canonical command | Behavior |
| --- | --- | --- |
| Before a shell tool | `node .agents/hooks/pre-tool.mjs <harness>` | Denies high-confidence destructive, merge, direct-default-branch, live-runtime, remote-host, and production-deploy commands |
| Before completion | `node .agents/hooks/stop-check.mjs <harness>` | Runs `git diff --check` and `pnpm agents:check` when available; requests at most two repair retries |

`<harness>` is `codex`, `claude`, or `cursor`, which only changes the JSON response envelope. The policy itself is shared.

## Limitations

Hooks are a guardrail, not a security boundary. They intentionally match only commands with a high-confidence dangerous shape; repository policy and human review remain authoritative. A blocked action must be redesigned safely or explicitly escalated, never obfuscated to bypass matching.

Keep policy classification pure in `policy.mjs`. Add regression fixtures for every new rule and validate all three response envelopes.
