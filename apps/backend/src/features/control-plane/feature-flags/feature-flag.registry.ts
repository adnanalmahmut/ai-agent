export const FEATURE_FLAGS = {
  'agents.enabled': {
    description: 'Accept new agent runs.',
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
    defaultEnabled: false,
    organizationOverridable: true,
  },
} as const satisfies Record<string, FeatureFlagDefinition>;

export type FeatureFlagDefinition = {
  description: string;
  defaultEnabled: boolean;
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
