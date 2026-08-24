import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import type { Job } from 'bullmq';

import { FeatureFlagService } from '../../src/control-plane';
import { KNOWLEDGE_DOCUMENT_INGESTED } from '../../src/knowledge/knowledge.events';
import {
  EMBEDDING_DIMENSIONS,
  KnowledgeEmbeddingHandler,
  KnowledgeRetrievalService,
  type KnowledgeDocumentIngestedJob,
} from '../../src/knowledge';
import {
  as,
  createHarness,
  createUser,
  type Harness,
  type TestUser,
} from '../support/auth-harness';

/**
 * The actor recorded on control-plane writes this harness makes.
 *
 * The audit log records who changed a flag, and these setups change flags — so
 * every call has to name somebody. A fixed non-user id rather than a session
 * user: the events are the harness's own, and attributing them to a test member
 * would put rows in the log that read as though a member of the organization
 * had reached the operator surface.
 */
const CONTROL_PLANE_ACTOR = 'e2e-harness';

/** A registry member: the taxonomy is code-owned and closed. */
const SLUG = 'organization.profile';

/**
 * Ingest, embed, retrieve — the whole path, with the provider substituted.
 *
 * The provider is a double and always will be in CI: a real embedding call
 * needs a credential this repository must never hold, and its output is not
 * deterministic enough to assert against. What is real here is everything
 * else — the transaction, the outbox row, the handler's idempotency, the
 * pgvector write, and the scoped query that reads it back.
 *
 * The double is deliberately *meaningful* rather than random. Each text is
 * embedded to a direction chosen by a keyword it contains, so "which passage
 * came back" is a question with a right answer and the retrieval assertions
 * are about ranking rather than about plumbing.
 */

const MODEL = 'fake-embedding-model';

/** A unit vector along one axis, so two texts are either identical or orthogonal. */
const axis = (index: number): number[] => {
  const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);
  vector[index] = 1;

  return vector;
};

const TOPICS = ['refund', 'shipping', 'warranty'] as const;

/**
 * Three paragraphs that stay three chunks, so a batch of one is three pages.
 *
 * Each is padded past the 200-character merge threshold deliberately: shorter
 * paragraphs are combined into a single chunk, and the paging assertions below
 * would then pass without ever paging.
 */
const THREE_TOPICS = [
  'Our refund window is thirty days from delivery. A refund is issued to the original payment method once the returned goods have been received and inspected by the returns team, which usually takes a further three working days after they arrive.',
  'Shipping is next day for express orders placed before noon. Orders placed after that cut-off are dispatched the following working day, and deliveries to addresses outside the mainland may take an additional two days to arrive with the customer.',
  'The warranty covers manufacturing defects for two years. It does not cover accidental damage, ordinary wear, or any fault arising from a repair carried out by somebody other than an engineer approved by the manufacturer of the product.',
].join('\n\n');

/** Maps a text to a direction by the topic word it mentions. */
const embedByTopic = (text: string): number[] => {
  const index = TOPICS.findIndex((topic) => text.toLowerCase().includes(topic));

  return axis(index === -1 ? TOPICS.length : index);
};

const dataOf = <T>(body: unknown): T => (body as { data: T }).data;

describe('knowledge embedding pipeline', () => {
  let harness: Harness;
  let owner: TestUser;
  let superAdmin: TestUser;
  let organizationId: string;
  let spaceId: string;
  let handler: KnowledgeEmbeddingHandler;
  let retrieval: KnowledgeRetrievalService;
  let embedCalls: string[][];
  /** Mutable so a test can force paging and a mid-document failure. */
  let stubMaxBatch: number;
  let failOnCall: number | null;

  const run = (documentId: string) =>
    handler.handle({
      data: { documentId, organizationId },
    } as Job<KnowledgeDocumentIngestedJob>);

  beforeAll(async () => {
    embedCalls = [];
    stubMaxBatch = 96;
    failOnCall = null;

    harness = await createHarness({
      embeddings: {
        model: MODEL,
        dimensions: EMBEDDING_DIMENSIONS,
        get maxBatch() {
          return stubMaxBatch;
        },
        embed: (texts) => {
          embedCalls.push([...texts]);

          if (failOnCall === embedCalls.length) {
            return Promise.reject(new Error('provider refused the batch'));
          }

          return Promise.resolve(texts.map(embedByTopic));
        },
      },
    });

    owner = await createUser(harness);
    superAdmin = await createUser(harness, { role: 'super_admin' });
    handler = harness.app.get(KnowledgeEmbeddingHandler);
    retrieval = harness.app.get(KnowledgeRetrievalService);

    const created = await as(harness, owner).post(
      '/api/auth/organization/create',
      { name: 'embedding-acme', slug: `embedding-${Date.now().toString(36)}` },
    );
    expect(created.status).toBe(200);
    organizationId = (created.body as { id: string }).id;

    await harness.app.get(FeatureFlagService).setPlatformOverride({
      key: 'knowledge.enabled',
      enabled: true,
      actorUserId: superAdmin.id,
    });
  });

  afterAll(async () => {
    /**
     * The flag override is platform-wide and outlives this suite, so it is
     * cleared here. The outbox rows are cleared for the same reason: nothing
     * references a deleted document, so they would accumulate in a table two
     * other suites treat as theirs to truncate.
     */
    await harness.app.get(FeatureFlagService).clearPlatformOverride({
      key: 'knowledge.enabled',
      actorUserId: CONTROL_PLANE_ACTOR,
    });
    await harness.prisma.outboxEvent.deleteMany({
      where: { type: KNOWLEDGE_DOCUMENT_INGESTED },
    });
    await harness.prisma.knowledgeSpace.deleteMany({
      where: { organizationId },
    });
    await harness.close();
  });

  beforeEach(async () => {
    embedCalls = [];
    stubMaxBatch = 96;
    failOnCall = null;

    await harness.prisma.knowledgeSpace.deleteMany({
      where: { organizationId },
    });

    /**
     * The space row appears on first ingestion rather than through a create
     * call — the taxonomy is code-owned and there is no route that defines one.
     * Its id is still needed here, because retrieval is asked about space ids
     * rather than slugs, so it is read back from the database after the first
     * document has opened it.
     */
    await as(harness, owner)
      .put(
        `/organizations/${organizationId}/knowledge/spaces/${SLUG}/documents`,
        {
          title: 'Space opener',
          content: 'A sentence that opens the space.',
        },
      )
      .expect(200);

    spaceId = (
      await harness.prisma.knowledgeSpace.findFirstOrThrow({
        where: { organizationId, slug: SLUG },
        select: { id: true },
      })
    ).id;
  });

  const ingest = async (title: string, content: string) => {
    const response = await as(harness, owner).put(
      `/organizations/${organizationId}/knowledge/spaces/${SLUG}/documents`,
      { title, content },
    );
    expect(response.status).toBe(200);

    return dataOf<{ id: string; chunkCount: number }>(response.body);
  };

  it('embeds a document and makes it retrievable', async () => {
    const document = await ingest(
      'Policies',
      'Our refund window is thirty days.\n\nShipping is next day for express orders.',
    );

    // Nothing is retrievable before the job runs: the text is durable, the
    // vectors are owed.
    const before = await retrieval.search({
      organizationId,
      spaceIds: [spaceId],
      embedding: axis(0),
      embeddingModel: MODEL,
    });
    expect(before).toEqual([]);

    await run(document.id);

    const after = await retrieval.search({
      organizationId,
      spaceIds: [spaceId],
      embedding: axis(0),
      embeddingModel: MODEL,
    });

    expect(after).toHaveLength(document.chunkCount);
    expect(after[0]?.content).toContain('refund');
  });

  it('ranks by the topic the query asked about', async () => {
    const document = await ingest(
      'Policies',
      'Our refund window is thirty days.\n\nShipping is next day for express orders.',
    );
    await run(document.id);

    const shipping = await retrieval.search({
      organizationId,
      spaceIds: [spaceId],
      embedding: axis(1),
      embeddingModel: MODEL,
    });

    expect(shipping[0]?.content).toContain('Shipping');
  });

  /**
   * Delivery is at-least-once by construction, so this is a normal event and
   * not an edge case. A second run must cost nothing — each chunk is a billed
   * provider call.
   */
  it('does nothing on a redelivered job', async () => {
    const document = await ingest(
      'Policies',
      'Our refund window is thirty days.',
    );

    await run(document.id);
    const firstCalls = embedCalls.length;
    expect(firstCalls).toBeGreaterThan(0);

    await run(document.id);

    expect(embedCalls).toHaveLength(firstCalls);
  });

  /**
   * A worker killed part way through leaves some chunks embedded and some not.
   * The redelivery has to finish the job rather than start it again.
   */
  it('embeds only what is still missing after a partial failure', async () => {
    const document = await ingest(
      'Policies',
      'Our refund window is thirty days.\n\nShipping is next day for express orders.\n\nThe warranty lasts a year.',
    );
    await run(document.id);

    // Simulate one chunk having been lost before its vector was written.
    const [orphan] = await harness.prisma.knowledgeChunk.findMany({
      where: { documentId: document.id },
      orderBy: { ordinal: 'asc' },
      take: 1,
      select: { id: true },
    });
    await harness.prisma.$executeRaw`
      UPDATE "knowledge_chunk"
      SET "embedding" = NULL, "embeddingModel" = NULL
      WHERE "id" = ${orphan?.id ?? ''}
    `;

    embedCalls = [];
    await run(document.id);

    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]).toHaveLength(1);
  });

  /**
   * Re-ingesting replaces the chunks, so the new ones have no vectors and the
   * old ones are gone. The second job must embed the replacements rather than
   * conclude the document is already done.
   */
  it('embeds the replacements after the text changes', async () => {
    const first = await ingest('Policies', 'Our refund window is thirty days.');
    await run(first.id);

    const second = await ingest(
      'Policies',
      'Our refund window is thirty days.\n\nThe warranty lasts a year.',
    );
    expect(second.id).toBe(first.id);

    embedCalls = [];
    await run(second.id);

    expect(embedCalls.flat().length).toBe(second.chunkCount);

    const warranty = await retrieval.search({
      organizationId,
      spaceIds: [spaceId],
      embedding: axis(2),
      embeddingModel: MODEL,
    });
    expect(warranty[0]?.content).toContain('warranty');
  });

  /**
   * The queue payload names an organization, and the handler carries it into
   * every statement. A job whose organization does not own the document must
   * touch nothing — not because a forged job is expected, but so the tenant
   * predicate is present on the write path as well as the read path.
   */
  it('embeds nothing for a job naming the wrong organization', async () => {
    const document = await ingest(
      'Policies',
      'Our refund window is thirty days.',
    );

    await handler.handle({
      data: {
        documentId: document.id,
        organizationId: '00000000-0000-4000-8000-000000000000',
      },
    } as Job<KnowledgeDocumentIngestedJob>);

    expect(embedCalls).toHaveLength(0);

    const found = await retrieval.search({
      organizationId,
      spaceIds: [spaceId],
      embedding: axis(0),
      embeddingModel: MODEL,
    });
    expect(found).toEqual([]);
  });

  /**
   * The reason the handler pages instead of embedding a document in one call.
   *
   * Embedding everything and writing at the end made the job all-or-nothing: a
   * provider failure on the last batch of a long document threw away every
   * vector the earlier batches had already been billed for, and the retry
   * bought them again. Forced here with a batch size of one, because a test
   * document is far smaller than a real batch.
   */
  describe('a provider failure part way through a document', () => {
    it('keeps what was already embedded and resumes there', async () => {
      stubMaxBatch = 1;

      const { id: documentId, chunkCount } = await ingest(
        'Policies',
        THREE_TOPICS,
      );

      expect(chunkCount).toBeGreaterThan(1);

      // The second page is refused; the first has already been written.
      failOnCall = 2;
      await expect(run(documentId)).rejects.toThrow();

      const embeddedAfterFailure = await harness.prisma.knowledgeChunk.count({
        where: { documentId, embeddingModel: MODEL },
      });
      expect(embeddedAfterFailure).toBe(1);

      // The redelivery asks only for what is still owed.
      failOnCall = null;
      embedCalls = [];
      await run(documentId);

      expect(embedCalls.flat()).toHaveLength(chunkCount - 1);
      expect(
        await harness.prisma.knowledgeChunk.count({
          where: { documentId, embeddingModel: MODEL },
        }),
      ).toBe(chunkCount);
    });

    it('advances past each page rather than re-reading it', async () => {
      stubMaxBatch = 1;

      const { id: documentId, chunkCount } = await ingest(
        'Policies',
        THREE_TOPICS,
      );

      await run(documentId);

      // One request per chunk, and no chunk asked for twice.
      expect(embedCalls).toHaveLength(chunkCount);
      expect(new Set(embedCalls.flat()).size).toBe(chunkCount);
    });
  });

  it('refuses a job with no document', async () => {
    await expect(
      handler.handle({
        data: { organizationId },
      } as Job<KnowledgeDocumentIngestedJob>),
    ).rejects.toThrow(/documentId/);
  });

  it('refuses a job with no organization', async () => {
    await expect(
      handler.handle({
        data: { documentId: 'anything' },
      } as Job<KnowledgeDocumentIngestedJob>),
    ).rejects.toThrow(/organizationId/);
  });
});
