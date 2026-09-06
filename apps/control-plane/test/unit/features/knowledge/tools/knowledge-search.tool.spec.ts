import { describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';

import { MODEL_IDS } from '../../../../../src/ai/models/model-catalog';
import type {
  AgentDefinition,
  ContextPolicy,
} from '../../../../../src/ai/agents/agent.types';
import { knowledgeSearchInput } from '../../../../../src/features/knowledge/tools/knowledge-search';
import { KnowledgeSearchTool } from '../../../../../src/features/knowledge/tools/knowledge-search.tool';

const policy: ContextPolicy = {
  spaceSlugs: ['brand.voice'],
  maxChunks: 5,
  maxCharacters: 1_000,
};

const definitionWith = (contextPolicy?: ContextPolicy): AgentDefinition => ({
  id: 'test-agent',
  version: 1,
  runtime: 'mastra',
  instructions: 'Answer.',
  model: MODEL_IDS.openAiGpt4oMini,
  modelPolicy: {
    id: 'test-agent.model-policy.1',
    allowedModelIds: [MODEL_IDS.openAiGpt4oMini],
  },
  input: z.unknown(),
  output: z.unknown(),
  ...(contextPolicy ? { contextPolicy } : {}),
});

const toolWith = (passages: { space: string; content: string }[] = []) => {
  const assemble = jest
    .fn<(input: unknown) => Promise<unknown>>()
    .mockResolvedValue(passages);

  return { tool: new KnowledgeSearchTool({ assemble } as never), assemble };
};

const context = (definition: AgentDefinition) => ({
  organizationId: 'org_1',
  agentRunId: 'run_1',
  agentRunAttempt: 1,
  definition,
});

describe('knowledge.search@1 input', () => {
  it.each([
    ['organizationId', { query: 'a', organizationId: 'org_2' }],
    ['spaceIds', { query: 'a', spaceIds: ['space_1'] }],
    ['spaceSlugs', { query: 'a', spaceSlugs: ['brand.voice'] }],
    ['limit', { query: 'a', limit: 500 }],
    [
      'embeddingModel',
      { query: 'a', embeddingModel: 'text-embedding-3-large' },
    ],
  ])('refuses a caller-supplied %s', (_field, input) => {
    expect(knowledgeSearchInput.safeParse(input).success).toBe(false);
  });

  it.each([[''], ['   '], ['x'.repeat(501)]])(
    'refuses an unusable query %p',
    (query) => {
      expect(knowledgeSearchInput.safeParse({ query }).success).toBe(false);
    },
  );
});

describe('KnowledgeSearchTool', () => {
  it('searches the caller organization within the pinned definition policy', async () => {
    const { tool, assemble } = toolWith([
      { space: 'brand-guidelines', content: 'Use sentence case.' },
    ]);
    const definition = definitionWith(policy);

    await expect(
      tool.execute({ query: 'tone' }, context(definition)),
    ).resolves.toEqual({
      passages: [{ space: 'brand-guidelines', content: 'Use sentence case.' }],
    });

    expect(assemble).toHaveBeenCalledWith({
      organizationId: 'org_1',
      policy,
      query: 'tone',
    });
  });

  it('passes no policy for an agent that may read nothing', async () => {
    const { tool, assemble } = toolWith();
    const definition = definitionWith();

    await expect(
      tool.execute({ query: 'tone' }, context(definition)),
    ).resolves.toEqual({ passages: [] });

    expect(assemble).toHaveBeenCalledWith({
      organizationId: 'org_1',
      policy: undefined,
      query: 'tone',
    });
  });

  it('takes the organization from context, never from the arguments', async () => {
    const { tool, assemble } = toolWith();

    await tool.execute({ query: 'tone' }, context(definitionWith(policy)));

    expect(assemble.mock.calls[0]?.[0]).toMatchObject({
      organizationId: 'org_1',
    });
  });

  it('parses its own input rather than assuming the gateway did', async () => {
    const { tool } = toolWith();

    await expect(
      tool.execute({ query: '' }, context(definitionWith(policy))),
    ).rejects.toThrow();
  });
});
