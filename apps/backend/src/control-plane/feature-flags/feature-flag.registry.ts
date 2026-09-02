/**
 * Every feature flag the application has, declared in code.
 *
 * A registry rather than free-form rows, for the same reason routes are code:
 * an operator cannot invent a flag, a typo in the Platform cannot create one
 * that silently reads as `false` forever, and deleting a flag from the code
 * makes every stale override visibly orphaned rather than quietly meaningful.
 *
 * Scope is per flag and not a global capability. Some things are a platform
 * decision — whether the agent runtime accepts work at all — and letting one
 * organization override that would be a way to keep using a subsystem an
 * operator has deliberately stopped. Others are exactly what per-organization
 * rollout is for.
 */
export const FEATURE_FLAGS = {
  'agents.enabled': {
    description: 'Accept new agent runs.',
    /**
     * Default off. This gates a subsystem that costs money per invocation, so
     * the safe default is the one that does nothing until somebody decides
     * otherwise.
     *
     * The coarse switch: every acceptance boundary that queues agent work
     * checks this before checking its own feature's flag, so turning it off
     * stops all of them at once.
     */
    defaultEnabled: false,
    organizationOverridable: true,
  },
  'knowledge.enabled': {
    description: 'Accept new knowledge ingestion for an organization.',
    defaultEnabled: false,
    organizationOverridable: true,
  },
  'content_ideas.enabled': {
    description: 'Accept content-idea generation requests.',
    defaultEnabled: false,
    organizationOverridable: true,
  },
  'mcp.enabled': {
    description: 'Accept MCP sessions and tool calls over the MCP endpoint.',
    /**
     * Default off, like every other acceptance boundary that spends money —
     * and with one addition specific to this one: it is the only boundary that
     * hands tool execution to a client outside this system. An operator turns
     * that on deliberately.
     *
     * Checked on session acceptance *and* on every tool call, unlike the
     * feature flags above. Those gate work that finishes on its own, so
     * refusing acceptance is enough to stop the spending. A session lives up
     * to an hour and spends on each call, so a switch that only gated
     * acceptance would leave every open session free to keep calling tools
     * after an operator had stopped the feature.
     */
    defaultEnabled: false,
    organizationOverridable: true,
  },
} as const satisfies Record<string, FeatureFlagDefinition>;

export type FeatureFlagDefinition = {
  description: string;
  defaultEnabled: boolean;
  /**
   * Whether an organization-scoped override may exist for this flag.
   *
   * Enforced when the override is written, not when it is read. A flag that
   * stopped being organization-overridable would otherwise leave rows that the
   * evaluator silently ignored, which is a worse state than a rejected write.
   */
  organizationOverridable: boolean;
};

export type FeatureFlagKey = keyof typeof FEATURE_FLAGS;

export const FEATURE_FLAG_KEYS = Object.keys(FEATURE_FLAGS) as FeatureFlagKey[];

export function isFeatureFlagKey(value: string): value is FeatureFlagKey {
  return Object.hasOwn(FEATURE_FLAGS, value);
}

export function featureFlagDefinition(
  key: FeatureFlagKey,
): FeatureFlagDefinition {
  return FEATURE_FLAGS[key];
}
