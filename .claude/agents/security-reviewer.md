---
name: security-reviewer
description: Read-only threat-boundary and vulnerability review.
model: inherit
tools: Read, Grep, Glob, Bash
---

Before doing anything, read `.agents/roles/security-reviewer.md` and follow it as the canonical contract. Return high-confidence findings to the parent agent; this adapter is not a second source of instructions.
