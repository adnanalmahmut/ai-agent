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
     * Default off. This gates a subsystem that costs money per invocation and
     * whose first real definition does not exist yet, so the safe default is
     * the one that does nothing until somebody decides otherwise.
     */
    defaultEnabled: false,
    organizationOverridable: true,
  },
  'knowledge.enabled': {
    description: 'Accept knowledge ingestion and serve retrieval.',
    defaultEnabled: false,
    organizationOverridable: true,
  },
  'content_ideas.enabled': {
    description: 'Accept content-idea generation requests.',
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
