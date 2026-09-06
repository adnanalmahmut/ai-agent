import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

import type {
  KnowledgeMatch,
  RetrievalQuery,
} from '../../../src/features/knowledge';
import {
  ALLOWED_SPACES,
  CROSS_TENANT_CANARY,
  DEFAULT_NUMBER_OF_IDEAS,
  EVAL_CASES,
  EVAL_CORPUS,
  EXCLUDED_SPACE_CANARY,
  validAnswerFor,
  type EvalCase,
  type EvalDocument,
} from './content-idea.eval-cases';

const generate =
  jest.fn<
    (prompt: string, options?: unknown) => Promise<{ object?: unknown }>
  >();
const setLogger = jest.fn<(logger: unknown) => void>();
const Agent = jest.fn(() => ({ generate, __setLogger: setLogger }));

jest.unstable_mockModule('@mastra/core/agent', () => ({ Agent }));

let AgentRunner: typeof import('../../../src/ai/execution/agent-runner.service').AgentRunner;
let AgentContextAssembler: typeof import('../../../src/features/knowledge/agent-context.assembler').AgentContextAssembler;
let AgentDefinitionRegistry: typeof import('../../../src/ai/agents/agent-definition.registry').AgentDefinitionRegistry;
let AgentRuntimeRegistry: typeof import('../../../src/ai/execution/agent-runtime.registry').AgentRuntimeRegistry;
let MastraRuntime: typeof import('../../../src/ai/infrastructure/runtimes/mastra/mastra.runtime').MastraRuntime;
let KnowledgeRetrievalService: typeof import('../../../src/features/knowledge/knowledge-retrieval.service').KnowledgeRetrievalService;
let KnowledgeSpaceService: typeof import('../../../src/features/knowledge/knowledge-space.service').KnowledgeSpaceService;
let contentIdeaAgent: typeof import('../../../src/features/content/ideas/agent-definitions/content-idea').contentIdeaAgent;
let CONTENT_IDEA_AGENT_ID: string;
let CONTENT_IDEA_AGENT_VERSION: number;

beforeAll(async () => {
  ({ AgentRunner } =
    await import('../../../src/ai/execution/agent-runner.service'));
  ({ AgentContextAssembler } =
    await import('../../../src/features/knowledge/agent-context.assembler'));
  ({ AgentDefinitionRegistry } =
    await import('../../../src/ai/agents/agent-definition.registry'));
  ({ AgentRuntimeRegistry } =
    await import('../../../src/ai/execution/agent-runtime.registry'));
  ({ MastraRuntime } =
    await import('../../../src/ai/infrastructure/runtimes/mastra/mastra.runtime'));
  ({ KnowledgeRetrievalService } =
    await import('../../../src/features/knowledge/knowledge-retrieval.service'));
  ({ KnowledgeSpaceService } =
    await import('../../../src/features/knowledge/knowledge-space.service'));
  ({ contentIdeaAgent, CONTENT_IDEA_AGENT_ID, CONTENT_IDEA_AGENT_VERSION } =
    await import('../../../src/features/content/ideas/agent-definitions/content-idea'));
});

const spaceIdOf = (document: Pick<EvalDocument, 'organizationId' | 'slug'>) =>
  `${document.organizationId}::${document.slug}`;

const SPACES = [
  ...new Map(
    EVAL_CORPUS.map((document) => [
      spaceIdOf(document),
      {
        id: spaceIdOf(document),
        organizationId: document.organizationId,
        slug: document.slug,
      },
    ]),
  ).values(),
];

const EMBEDDING_MODEL = 'eval-embedding-model';

const retrievalPort = {
  search: (query: RetrievalQuery): Promise<KnowledgeMatch[]> => {
    if (query.spaceIds.length === 0) return Promise.resolve([]);

    const allowed = new Set(query.spaceIds);

    const matches = EVAL_CORPUS.filter(
      (document) =>
        document.organizationId === query.organizationId &&
        allowed.has(spaceIdOf(document)),
    ).map((document, index) => ({
      chunkId: `${spaceIdOf(document)}::${index}`,
      documentId: `${spaceIdOf(document)}::${index}`,
      spaceId: spaceIdOf(document),
      content: document.content,
      score: 1 - index / 1_000,
    }));

    return Promise.resolve(matches.slice(0, query.limit));
  },
};

const embeddingPort = {
  model: EMBEDDING_MODEL,
  dimensions: 3,
  maxBatch: 8,
  embed: (texts: readonly string[]) =>
    Promise.resolve(texts.map(() => [0.1, 0.2, 0.3])),
};

const prisma = {
  knowledgeSpace: {
    findMany: ({
      where,
    }: {
      where: { organizationId: string; slug: { in: string[] } };
    }) =>
      Promise.resolve(
        SPACES.filter(
          (space) =>
            space.organizationId === where.organizationId &&
            where.slug.in.includes(space.slug),
        ).map((space) => ({ id: space.id, slug: space.slug })),
      ),
  },
};

const runtimeConfig = {
  setting: () => Promise.resolve(100),
  secret: () => Promise.resolve('sk-eval-not-a-real-key'),
};

type Harness = {
  run: (organizationId: string, input: unknown) => Promise<{ output: unknown }>;
};

const buildHarness = (): Harness => {
  const spaces = new KnowledgeSpaceService(
    prisma as never,
    runtimeConfig as never,
  );
  const retrieval = new KnowledgeRetrievalService(
    retrievalPort,
    runtimeConfig as never,
  );
  const assembler = new AgentContextAssembler(spaces, retrieval, embeddingPort);
  const definitions = new AgentDefinitionRegistry([contentIdeaAgent]);
  const runtimes = new AgentRuntimeRegistry(new MastraRuntime(runtimeConfig));
  const runner = new AgentRunner(
    definitions,
    runtimes,
    assembler,
    { pinnedVersionFor: () => Promise.resolve(null) } as never,
    { authorize: () => [] } as never,
  );

  return {
    run: (organizationId, input) =>
      runner.run({
        id: 'run_1',
        attemptCount: 1,
        agentId: CONTENT_IDEA_AGENT_ID,
        agentVersion: CONTENT_IDEA_AGENT_VERSION,
        organizationAgentVersionId: null,
        modelPolicyId: null,
        modelId: null,
        modelPricingRevisionId: null,
        createdAt: new Date('2026-08-27T00:00:00.000Z'),
        runtime: contentIdeaAgent.runtime,
        organizationId,
        input: input as never,
      }),
  };
};

const sentPrompt = () => generate.mock.calls[0]?.[0] ?? '';

const promptSpaces = (): string[] => [
  ...new Set(
    [...sentPrompt().matchAll(/space="([^"]+)"/g)].map((match) => match[1]),
  ),
];

const passageCount = () => sentPrompt().match(/<passage /g)?.length ?? 0;

const requestedCount = (request: unknown): number => {
  if (typeof request !== 'object' || request === null) {
    return DEFAULT_NUMBER_OF_IDEAS;
  }

  const value = (request as { numberOfIdeas?: unknown }).numberOfIdeas;

  return typeof value === 'number' ? value : DEFAULT_NUMBER_OF_IDEAS;
};

const answerFor = (testCase: EvalCase): unknown =>
  testCase.providerAnswer ?? validAnswerFor(requestedCount(testCase.request));

const ideaCountOf = (answer: unknown): number => {
  const ideas = (answer as { ideas?: unknown }).ideas;

  return Array.isArray(ideas) ? ideas.length : 0;
};

const proseOf = (answer: unknown): string[] => {
  const ideas = (answer as { ideas?: unknown }).ideas;

  if (!Array.isArray(ideas)) return [];

  return ideas.flatMap((idea) =>
    Object.values(idea as Record<string, unknown>).filter(
      (value): value is string => typeof value === 'string',
    ),
  );
};

describe('content-idea@1 evaluation', () => {
  let harness: Harness;

  beforeEach(() => {
    generate.mockReset();
    setLogger.mockClear();
    Agent.mockClear();
    harness = buildHarness();
  });

  it('covers the documented breadth of cases', () => {
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(22);

    const ids = EVAL_CASES.map((testCase) => testCase.id).join(' ');
    expect(ids).toContain('language-arabic');
    expect(ids).toContain('language-english');
    expect(EVAL_CASES.some((testCase) => testCase.expect.rejectsOutput)).toBe(
      true,
    );
    expect(EVAL_CASES.some((testCase) => testCase.expect.rejectsInput)).toBe(
      true,
    );
    expect(
      EVAL_CASES.some((testCase) => testCase.expect.rejectsOutputContract),
    ).toBe(true);
  });

  describe.each(EVAL_CASES.map((testCase) => [testCase.id, testCase] as const))(
    '%s',
    (unusedId: string, testCase: EvalCase) => {
      it(testCase.intent, async () => {
        generate.mockResolvedValue({ object: answerFor(testCase) });

        const attempt = harness.run(testCase.organizationId, testCase.request);

        if (testCase.expect.rejectsInput === true) {
          await expect(attempt).rejects.toThrow();
          expect(generate).not.toHaveBeenCalled();

          return;
        }

        if (testCase.expect.rejectsOutput === true) {
          await expect(attempt).rejects.toThrow(
            'does not satisfy its declared schema',
          );
          expect(generate).toHaveBeenCalled();

          return;
        }

        if (testCase.expect.rejectsOutputContract === true) {
          const expected = requestedCount(testCase.request);
          const received = ideaCountOf(answerFor(testCase));

          await expect(attempt).rejects.toThrow(
            new RegExp(
              `^Agent output does not satisfy its declared contract: count_mismatch \\(expected ${expected}, received ${received}\\)$`,
            ),
          );

          const reason = await attempt.then(
            () => '',
            (error: unknown) =>
              error instanceof Error ? error.message : String(error),
          );

          for (const prose of proseOf(answerFor(testCase))) {
            expect(reason).not.toContain(prose);
          }

          expect(generate).toHaveBeenCalled();

          return;
        }

        const result = await attempt;

        expect(result.output).toEqual(answerFor(testCase));

        for (const fragment of testCase.expect.promptContains ?? []) {
          expect(sentPrompt()).toContain(fragment);
        }

        for (const fragment of testCase.expect.promptExcludes ?? []) {
          expect(sentPrompt()).not.toContain(fragment);
        }

        if (testCase.expect.contextSpaces !== undefined) {
          expect(promptSpaces().sort()).toEqual(
            [...testCase.expect.contextSpaces].sort(),
          );
        }

        if (testCase.expect.contextEmpty === true) {
          expect(passageCount()).toBe(0);
          expect(sentPrompt()).not.toContain('<reference>');
        }

        if (testCase.expect.maxPassages !== undefined) {
          expect(passageCount()).toBeLessThanOrEqual(
            testCase.expect.maxPassages,
          );
          expect(passageCount()).toBeGreaterThan(0);
        }

        for (const [field, value] of Object.entries(
          testCase.expect.normalized ?? {},
        )) {
          expect(sentPrompt()).toContain(
            `${JSON.stringify(field)}:${JSON.stringify(value)}`,
          );
        }
      });
    },
  );

  it('never puts excluded-space or cross-tenant material into any prompt', async () => {
    const prompts: string[] = [];

    for (const testCase of EVAL_CASES) {
      generate.mockReset();
      generate.mockResolvedValue({ object: answerFor(testCase) });

      await harness
        .run(testCase.organizationId, testCase.request)
        .catch(() => undefined);

      prompts.push(sentPrompt());
    }

    const everything = prompts.join('\n');

    expect(everything).not.toContain(EXCLUDED_SPACE_CANARY);
    expect(everything).not.toContain(CROSS_TENANT_CANARY);
    expect(everything.length).toBeGreaterThan(0);
  });

  it('reads exactly the four spaces the fixtures are built around', () => {
    expect([...contentIdeaAgent.contextPolicy!.spaceSlugs].sort()).toEqual(
      [...ALLOWED_SPACES].sort(),
    );

    for (const slug of ALLOWED_SPACES) {
      expect(EVAL_CORPUS.some((document) => document.slug === slug)).toBe(true);
    }
  });
});
