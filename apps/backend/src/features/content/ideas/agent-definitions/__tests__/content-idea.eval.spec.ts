import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

import type { KnowledgeMatch, RetrievalQuery } from '../../../../knowledge';
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

/**
 * `content-idea@1`, evaluated end to end without a provider.
 *
 * Every case in `content-idea.eval-cases.ts` is driven through the *real*
 * pipeline — `AgentRunner`, the real `AgentContextAssembler`, the real
 * `KnowledgeSpaceService` and `KnowledgeRetrievalService`, and the real
 * `MastraRuntime` — with exactly three fakes at the edges: the Mastra `Agent`
 * class, the embedding provider, and the pgvector adapter. That is the point of
 * the shape: a suite that reimplemented context assembly to test it would be
 * asserting against its own copy of the thing under test, and the bugs this set
 * exists to catch — a policy naming a space nobody stores under, a tenant
 * predicate applied after ranking — live precisely in the code such a suite
 * would have replaced.
 *
 * Mocking `@mastra/core/agent` at the module level is what makes the prompt
 * observable. The adapter's own containment suite proves the logger behavior
 * against the real SDK; this one reads the string the adapter would have sent.
 *
 * ## What a green run means
 *
 * That the request was normalized as specified, that the language and goal
 * reached the provider, that the context came from the declared spaces and
 * nowhere else, and that the answer was parsed before it could be stored. It
 * says nothing about whether the ideas are good — see the note at the top of
 * the cases file.
 */

const generate =
  jest.fn<
    (prompt: string, options?: unknown) => Promise<{ object?: unknown }>
  >();
const setLogger = jest.fn<(logger: unknown) => void>();
const Agent = jest.fn(() => ({ generate, __setLogger: setLogger }));

jest.unstable_mockModule('@mastra/core/agent', () => ({ Agent }));

let AgentRunner: typeof import('../../../../../ai/execution/agent-runner.service').AgentRunner;
let AgentContextAssembler: typeof import('../../../../knowledge/agent-context.assembler').AgentContextAssembler;
let AgentDefinitionRegistry: typeof import('../../../../../ai/agents/agent-definition.registry').AgentDefinitionRegistry;
let AgentRuntimeRegistry: typeof import('../../../../../ai/execution/agent-runtime.registry').AgentRuntimeRegistry;
let MastraRuntime: typeof import('../../../../../ai/infrastructure/runtimes/mastra/mastra.runtime').MastraRuntime;
let KnowledgeRetrievalService: typeof import('../../../../knowledge/knowledge-retrieval.service').KnowledgeRetrievalService;
let KnowledgeSpaceService: typeof import('../../../../knowledge/knowledge-space.service').KnowledgeSpaceService;
let contentIdeaAgent: typeof import('../content-idea').contentIdeaAgent;
let CONTENT_IDEA_AGENT_ID: string;
let CONTENT_IDEA_AGENT_VERSION: number;

beforeAll(async () => {
  ({ AgentRunner } =
    await import('../../../../../ai/execution/agent-runner.service'));
  ({ AgentContextAssembler } =
    await import('../../../../knowledge/agent-context.assembler'));
  ({ AgentDefinitionRegistry } =
    await import('../../../../../ai/agents/agent-definition.registry'));
  ({ AgentRuntimeRegistry } =
    await import('../../../../../ai/execution/agent-runtime.registry'));
  ({ MastraRuntime } =
    await import('../../../../../ai/infrastructure/runtimes/mastra/mastra.runtime'));
  ({ KnowledgeRetrievalService } =
    await import('../../../../knowledge/knowledge-retrieval.service'));
  ({ KnowledgeSpaceService } =
    await import('../../../../knowledge/knowledge-space.service'));
  ({ contentIdeaAgent, CONTENT_IDEA_AGENT_ID, CONTENT_IDEA_AGENT_VERSION } =
    await import('../content-idea'));
});

/** A stable space id, so a fixture document's tenant and slug are recoverable. */
const spaceIdOf = (document: Pick<EvalDocument, 'organizationId' | 'slug'>) =>
  `${document.organizationId}::${document.slug}`;

/**
 * The corpus, indexed the way the database indexes it.
 *
 * Built once from the fixture file so the fakes below cannot disagree with each
 * other about what exists — the space rows and the chunk rows are two views of
 * one list rather than two lists that have to be kept in step.
 */
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

/**
 * The pgvector adapter's contract, honoured rather than approximated.
 *
 * The two properties that matter are enforced here because they are what the
 * real adapter enforces in SQL: the tenant and space predicates are applied
 * *before* the ranking is cut to `limit`, and an empty `spaceIds` returns
 * nothing. A fake that filtered after slicing would make the isolation cases
 * pass for the wrong reason.
 *
 * Ranking is by corpus order, which is deterministic and is all these cases
 * need — none of them asserts relevance, because relevance is a property of a
 * real embedding model and there is not one here.
 */
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

/**
 * Slug resolution, scoped by organization exactly as the real query is.
 *
 * The isolation cases rest entirely on this predicate, so it is written as the
 * service's `where` clause is rather than as a convenience lookup: a fake that
 * resolved a slug without the tenant would make the cross-tenant case pass
 * against a service that had lost the predicate.
 */
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
  /** Well above the policy's own `maxChunks`, so the policy is what binds. */
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
    /**
     * Stubbed empty, which is what content-idea's grants actually are.
     *
     * This makes the eval a statement about the runner — that a tool-free run
     * behaves exactly as it did before tools existed. It is not the proof that
     * content-idea grants nothing; that is
     * `agent-definition-tool-grants.spec.ts`, which asserts it of every
     * production definition.
     */
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

/** The prompt the adapter would have sent, or the empty string if it never got there. */
const sentPrompt = () => generate.mock.calls[0]?.[0] ?? '';

/**
 * Every `<passage space="…">` label in the prompt.
 *
 * Read off the prompt rather than off the assembler's return value, because the
 * prompt is what the provider sees — a passage that reached the string but not
 * the assembler's result, or the reverse, is exactly the discrepancy worth
 * catching.
 */
const promptSpaces = (): string[] => [
  ...new Set(
    [...sentPrompt().matchAll(/space="([^"]+)"/g)].map((match) => match[1]),
  ),
];

const passageCount = () => sentPrompt().match(/<passage /g)?.length ?? 0;

/**
 * How many ideas a case's request will be understood to have asked for.
 *
 * Needed because the idea count is an *output contract* rather than a prompt
 * hint — an answer whose count differs from the request is refused. So a case
 * that does not care about output still needs an answer of the right size, and
 * the size is a property of its own request rather than of the fixture.
 */
const requestedCount = (request: unknown): number => {
  if (typeof request !== 'object' || request === null) {
    return DEFAULT_NUMBER_OF_IDEAS;
  }

  const value = (request as { numberOfIdeas?: unknown }).numberOfIdeas;

  return typeof value === 'number' ? value : DEFAULT_NUMBER_OF_IDEAS;
};

/** The provider answer a case supplies, or a well-formed one of the right size. */
const answerFor = (testCase: EvalCase): unknown =>
  testCase.providerAnswer ?? validAnswerFor(requestedCount(testCase.request));

/** How many ideas an answer actually carries, for the count assertions. */
const ideaCountOf = (answer: unknown): number => {
  const ideas = (answer as { ideas?: unknown }).ideas;

  return Array.isArray(ideas) ? ideas.length : 0;
};

/**
 * Every human-readable string in an answer.
 *
 * Used only in the negative: none of it may appear in the reason a contract
 * violation is reported with. These are the strings a model authored, and they
 * are the ones that must not travel to a log.
 */
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

  /**
   * The set is meant to cover the shapes a real deployment produces, and a case
   * quietly deleted is a shape that stopped being covered. Pinned as a floor
   * rather than an exact number so adding one is not a test edit.
   */
  it('covers the documented breadth of cases', () => {
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(22);

    // Both languages, and both halves of the output contract.
    const ids = EVAL_CASES.map((testCase) => testCase.id).join(' ');
    expect(ids).toContain('language-arabic');
    expect(ids).toContain('language-english');
    expect(EVAL_CASES.some((testCase) => testCase.expect.rejectsOutput)).toBe(
      true,
    );
    expect(EVAL_CASES.some((testCase) => testCase.expect.rejectsInput)).toBe(
      true,
    );
    // And the contract layer, which is neither of those two.
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
          // Refused before the provider was asked, which is the point: an
          // invalid request must not be billed for.
          expect(generate).not.toHaveBeenCalled();

          return;
        }

        if (testCase.expect.rejectsOutput === true) {
          // The message, not just a rejection: the two output layers are
          // asserted separately so a case cannot pass for the other one's
          // reason — and so deleting either check fails a test.
          await expect(attempt).rejects.toThrow(
            'does not satisfy its declared schema',
          );
          // The provider *was* asked — the refusal is of its answer, not of
          // the request — so this is a genuine output-parse assertion rather
          // than an input one wearing the wrong label.
          expect(generate).toHaveBeenCalled();

          return;
        }

        if (testCase.expect.rejectsOutputContract === true) {
          /**
           * The answer parsed and was still refused, which is the whole point
           * of the layer: `numberOfIdeas` is a business contract the schema
           * cannot state, because a schema never sees the request.
           *
           * The *whole* message is pinned, not a substring, and the answer's own
           * prose is asserted absent from it. That is the containment claim
           * rather than a formatting preference: a substring match would stay
           * green while a contract appended the model's titles and summaries to
           * the reason, which is how provider output reaches a log.
           */
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
          // Not vacuous: a broken assembler returning nothing would otherwise
          // satisfy an upper bound.
          expect(passageCount()).toBeGreaterThan(0);
        }

        for (const [field, value] of Object.entries(
          testCase.expect.normalized ?? {},
        )) {
          // The normalized input is what the adapter serializes, so reading it
          // back out of the prompt asserts the value the *provider* received
          // rather than the one the schema produced on its way there.
          expect(sentPrompt()).toContain(
            `${JSON.stringify(field)}:${JSON.stringify(value)}`,
          );
        }
      });
    },
  );

  /**
   * The two canaries, asserted once across the whole set rather than only in
   * the cases that name them.
   *
   * Any case that reached the provider is an opportunity for the leak, so the
   * strongest available statement is that no prompt produced by any case ever
   * contained either string. A per-case assertion would miss a leak that only
   * appears for, say, the sparse organization.
   */
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
    // Not vacuous: the set did reach the provider, repeatedly.
    expect(everything.length).toBeGreaterThan(0);
  });

  /**
   * The policy's spaces, asserted against the corpus rather than against
   * themselves.
   *
   * Restating the four slugs in the cases file would agree with the definition
   * however either changed. This checks the pair: the definition's policy is
   * exactly the set the fixtures were built to expect, and every one of them is
   * a space some fixture organization actually stores under — so a policy
   * naming a real registry slug that nothing is ever filed under would still be
   * caught.
   */
  it('reads exactly the four spaces the fixtures are built around', () => {
    expect([...contentIdeaAgent.contextPolicy!.spaceSlugs].sort()).toEqual(
      [...ALLOWED_SPACES].sort(),
    );

    for (const slug of ALLOWED_SPACES) {
      expect(EVAL_CORPUS.some((document) => document.slug === slug)).toBe(true);
    }
  });
});
