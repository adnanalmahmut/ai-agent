const rules = [
  {
    id: 'git-force-push',
    pattern: /\bgit\s+push\b[^\n]*(?:--force(?:-with-lease)?|(?:^|\s)-f(?:\s|$))/i,
    reason: 'Force-pushing is outside the repository delivery policy.',
  },
  {
    id: 'git-direct-main-push',
    pattern: /\bgit\s+push(?:\s+\S+)?\s+(?:HEAD:)?(?:refs\/heads\/)?(?:main|master)(?:\s|$)/i,
    reason: 'Direct pushes to the default branch are forbidden; publish a review branch instead.',
  },
  {
    id: 'git-destructive-reset',
    pattern: /\bgit\s+(?:reset\s+--hard|clean\s+-[^\s]*f)/i,
    reason: 'Destructive Git cleanup requires explicit human approval.',
  },
  {
    id: 'recursive-delete',
    pattern: /(?:^|[;&|]\s*)rm\s+-(?:[^\s]*r[^\s]*f|[^\s]*f[^\s]*r)\b/i,
    reason: 'Recursive forced deletion requires explicit human approval.',
  },
  {
    id: 'docker-volume-delete',
    pattern: /\bdocker(?:\s+compose)?\s+(?:down\b[^\n]*\s-v\b|(?:volume|system)\s+prune\b)/i,
    reason: 'Deleting container volumes or pruning Docker state is destructive.',
  },
  {
    id: 'github-merge',
    pattern: /\bgh\s+pr\s+merge\b|\bgh\s+pr\s+.*--auto\b/i,
    reason: 'Agents may prepare pull requests but must not merge or enable auto-merge.',
  },
  {
    id: 'production-workflow',
    pattern: /\bgh\s+workflow\s+run\b[^\n]*(?:production|deploy[-_ ]?prod)|\b(?:pnpm|npm|yarn)\s+(?:run\s+)?deploy(?::|-)?prod(?:uction)?\b/i,
    reason: 'Production deployment is a future, separately authorized operation.',
  },
  {
    id: 'runtime-env',
    pattern: /\/etc\/ai-agent\/runtime\.env\b/i,
    reason: 'The staged runtime environment file must not be read or changed by repository agents.',
  },
  {
    id: 'manual-remote-access',
    pattern: /(?:^|[;&|]\s*)(?:ssh|scp|sftp)\b/i,
    reason: 'Manual remote-host access is outside the repository automation boundary.',
  },
];

export function extractCommand(input) {
  const candidates = [
    input?.tool_input?.command,
    input?.tool_input?.cmd,
    input?.input?.command,
    input?.input?.cmd,
    input?.command,
    input?.cmd,
  ];

  return candidates.find((value) => typeof value === 'string') ?? '';
}

export function findViolation(command) {
  if (typeof command !== 'string' || command.trim() === '') return null;
  return rules.find((rule) => rule.pattern.test(command)) ?? null;
}

export function preToolDecision(harness, violation) {
  if (!violation) {
    return harness === 'cursor' ? { permission: 'allow' } : {};
  }

  const message = `[${violation.id}] ${violation.reason}`;

  if (harness === 'cursor') {
    return {
      permission: 'deny',
      user_message: message,
      agent_message: `${message} Choose a safe repository-local alternative or request approval.`,
    };
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: message,
    },
  };
}

export function stopDecision(harness, failures, input = {}) {
  if (failures.length === 0) return {};

  const repeated = input.stop_hook_active === true || Number(input.loop_count ?? 0) >= 2;
  const reason = `Repository completion checks failed: ${failures.join('; ')}`;
  if (repeated) {
    return harness === 'cursor'
      ? { system_message: `${reason}. The bounded retry limit is reached; report the failure.` }
      : { systemMessage: `${reason}. The bounded retry limit is reached; report the failure.` };
  }

  if (harness === 'cursor') {
    return { followup_message: `${reason}. Repair the evidenced issue, re-run validation, and stop after at most two retries.` };
  }

  if (harness === 'claude') return { decision: 'block', reason };

  return {
    hookSpecificOutput: {
      hookEventName: 'Stop',
      decision: 'block',
      reason,
    },
  };
}
