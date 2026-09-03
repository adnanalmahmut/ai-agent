import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';

import { AgentDefinitionRegistry } from '../../../../src/ai/agents/agent-definition.registry';
import type { AgentDefinition } from '../../../../src/ai/agents/agent.types';
import { PRODUCTION_AGENT_DEFINITIONS } from '../../../../src/features/content/ideas/agent-definitions';
import { MODEL_IDS } from '../../../../src/ai/models/model-catalog';
import type { ToolRef } from '../../../../src/ai/tools/tool.types';

const definition = (maxToolGrants?: readonly unknown[]): AgentDefinition => ({
  id: 'granting-agent',
  version: 1,
  runtime: 'mastra',
  instructions: 'Answer.',
  model: MODEL_IDS.openAiGpt4oMini,
  modelPolicy: {
    id: 'granting-agent.model-policy.1',
    allowedModelIds: [MODEL_IDS.openAiGpt4oMini],
  },
  input: z.unknown(),
  output: z.unknown(),
  ...(maxToolGrants ? { maxToolGrants: maxToolGrants as ToolRef[] } : {}),
});

describe('AgentDefinition maximum tool grants', () => {
  it('accepts a registered tool version', () => {
    const registry = new AgentDefinitionRegistry([
      definition(['knowledge.search@1']),
    ]);

    expect(registry.resolve('granting-agent', 1).maxToolGrants).toEqual([
      'knowledge.search@1',
    ]);
  });

  it('refuses a grant naming a tool that does not exist', () => {
    expect(
      () => new AgentDefinitionRegistry([definition(['invented@1'])]),
    ).toThrow('grants unknown tool "invented@1"');
  });

  /** The version is part of the identity, so the wrong one is unknown. */
  it('refuses a grant naming the wrong version of a real tool', () => {
    expect(
      () => new AgentDefinitionRegistry([definition(['knowledge.search@2'])]),
    ).toThrow('grants unknown tool "knowledge.search@2"');
  });

  /**
   * A duplicate type-checks perfectly and would make the "maximum" a multiset
   * whose size no longer means what a subset check assumes.
   */
  it('refuses a duplicated grant', () => {
    expect(
      () =>
        new AgentDefinitionRegistry([
          definition(['knowledge.search@1', 'knowledge.search@1']),
        ]),
    ).toThrow('grants duplicate tool');
  });

  it('freezes the grant list it hands out', () => {
    const registry = new AgentDefinitionRegistry([
      definition(['knowledge.search@1']),
    ]);

    expect(
      Object.isFrozen(registry.resolve('granting-agent', 1).maxToolGrants),
    ).toBe(true);
  });

  it('leaves a definition that declares no grants without the property', () => {
    const registry = new AgentDefinitionRegistry([definition()]);
    const resolved = registry.resolve('granting-agent', 1);

    expect(resolved.maxToolGrants).toBeUndefined();
    expect(Object.hasOwn(resolved, 'maxToolGrants')).toBe(false);
  });

  /**
   * TOOL-01 must not change what a published agent can do. `content-idea@1`
   * keeps its automatic retrieval path and gains no tools.
   */
  it('grants nothing to any production agent', () => {
    for (const production of PRODUCTION_AGENT_DEFINITIONS) {
      expect(production.maxToolGrants).toBeUndefined();
    }
  });
});
