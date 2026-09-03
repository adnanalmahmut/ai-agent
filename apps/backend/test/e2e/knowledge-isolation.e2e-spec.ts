import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from '@jest/globals';

import {
  EMBEDDING_DIMENSIONS,
  KnowledgeRetrievalService,
  KnowledgeWriterService,
} from '../../src/features/knowledge';
import { createHarness, type Harness } from '../support/auth-harness';

/**
 * Tenant isolation, against real PostgreSQL and real pgvector.
 *
 * This is the one property in the Knowledge domain that cannot be proved
 * anywhere else. A unit test with a fake repository asserts that the service
 * passes an organization id along; it cannot show that the id *scopes*
 * anything, because there is no database to scope. The failure mode being
 * guarded against — a predicate dropped from the ranking query, or applied
 * after it — passes every in-memory test ever written and returns another
 * organization's material in production.
 *
 * The fixtures are built so a broken predicate cannot pass by luck. The other
 * organization's chunk is not merely present; it is a *closer* match than
 * anything the querying organization owns. An unscoped or post-filtered query
 * therefore returns it first, or returns nothing at all where it should return
 * something — either way, loudly.
 */

/**
 * A unit vector along one axis. Two of these are as close or as far apart as
 * embeddings get, which makes "which came back first" unambiguous.
 */
const axis = (index: number, magnitude = 1): number[] => {
  const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);
  vector[index] = magnitude;

  return vector;
};

/** Halfway between two axes: a deliberately worse match than either. */
const between = (a: number, b: number): number[] => {
  const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);
  vector[a] = 0.7071;
  vector[b] = 0.7071;

  return vector;
};

const QUERY = axis(0);
const MODEL = 'test-embedding-model';

describe('knowledge retrieval isolation', () => {
  let harness: Harness;
  let retrieval: KnowledgeRetrievalService;
  let writer: KnowledgeWriterService;

  const created = {
    organizations: [] as string[],
  };

  beforeAll(async () => {
    harness = await createHarness();
    retrieval = harness.app.get(KnowledgeRetrievalService);
    writer = harness.app.get(KnowledgeWriterService);
  });

  afterAll(async () => {
    await harness.close();
  });

  afterEach(async () => {
    // Chunks and documents cascade from their space; spaces and organizations
    // do not cascade from anything, so they are removed explicitly and in
    // order. Nothing here relies on a shared fixture surviving between tests.
    await harness.prisma.knowledgeSpace.deleteMany({
      where: { organizationId: { in: created.organizations } },
    });
    await harness.prisma.organization.deleteMany({
      where: { id: { in: created.organizations } },
    });
    created.organizations = [];
  });

  /** One organization holding one space with one embedded chunk. */
  const seed = async (input: {
    name: string;
    spaceSlug: string;
    content: string;
    embedding: number[];
  }) => {
    const organization = await harness.prisma.organization.create({
      data: { name: input.name, slug: `${input.name}-${Date.now()}` },
      select: { id: true },
    });
    created.organizations.push(organization.id);

    const space = await harness.prisma.knowledgeSpace.create({
      data: {
        organizationId: organization.id,
        slug: input.spaceSlug,
        name: input.spaceSlug,
      },
      select: { id: true },
    });

    const document = await harness.prisma.knowledgeDocument.create({
      data: {
        organizationId: organization.id,
        spaceId: space.id,
        title: input.content,
        checksum: 'test-checksum',
      },
      select: { id: true },
    });

    const chunk = await harness.prisma.knowledgeChunk.create({
      data: {
        organizationId: organization.id,
        spaceId: space.id,
        documentId: document.id,
        ordinal: 0,
        content: input.content,
      },
      select: { id: true },
    });

    const embedded = await writer.setEmbedding({
      chunkId: chunk.id,
      organizationId: organization.id,
      embedding: input.embedding,
      model: MODEL,
    });

    expect(embedded).toBe(true);

    return {
      organizationId: organization.id,
      spaceId: space.id,
      documentId: document.id,
      chunk,
    };
  };

  /**
   * The central assertion. The other organization's chunk is an exact match
   * for the query and this one's is not, so any query that is not scoped in
   * the database returns the wrong row first.
   */
  it('never returns another organization’s chunk, even when it is the closer match', async () => {
    const mine = await seed({
      name: 'mine',
      spaceSlug: 'brand',
      content: 'my own material',
      embedding: between(0, 1),
    });
    const theirs = await seed({
      name: 'theirs',
      spaceSlug: 'brand',
      content: 'their material, an exact match',
      embedding: QUERY,
    });

    // Both spaces are passed so the space predicate alone cannot filter out
    // the other organization's chunk. The organizationId predicate itself
    // must be load-bearing.
    const results = await retrieval.search({
      organizationId: mine.organizationId,
      spaceIds: [mine.spaceId, theirs.spaceId],
      embedding: QUERY,
      embeddingModel: MODEL,
      limit: 10,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.chunkId).toBe(mine.chunk.id);
    // Provenance too, not only identity: a citation surface built on these
    // fields is wrong in a way nothing else here would notice if the mapper
    // transposed them.
    expect(results[0]?.spaceId).toBe(mine.spaceId);
    expect(results[0]?.documentId).toBe(mine.documentId);
    expect(results.map((match) => match.content)).not.toContain(
      'their material, an exact match',
    );

    // And the same in reverse, so the test cannot pass because one direction
    // happens to be ordered favourably.
    const other = await retrieval.search({
      organizationId: theirs.organizationId,
      spaceIds: [mine.spaceId, theirs.spaceId],
      embedding: QUERY,
      embeddingModel: MODEL,
      limit: 10,
    });

    expect(other.map((match) => match.chunkId)).toEqual([theirs.chunk.id]);
  });

  /**
   * The other half of scoping. A space id is not a capability: holding one
   * that belongs elsewhere must not read it, or an agent's context policy
   * would be enforceable only by whoever remembered to check the owner.
   */
  it('returns nothing for a space id that belongs to another organization', async () => {
    const mine = await seed({
      name: 'mine',
      spaceSlug: 'brand',
      content: 'my own material',
      embedding: axis(1),
    });
    const theirs = await seed({
      name: 'theirs',
      spaceSlug: 'brand',
      content: 'their material',
      embedding: QUERY,
    });

    const results = await retrieval.search({
      organizationId: mine.organizationId,
      spaceIds: [theirs.spaceId],
      embedding: QUERY,
      embeddingModel: MODEL,
      limit: 10,
    });

    expect(results).toEqual([]);
  });

  /**
   * Within one organization, a space the caller was not granted is as
   * invisible as another tenant's. This is what makes a context policy a
   * boundary rather than a suggestion.
   */
  it('reads only the spaces the caller was granted', async () => {
    const granted = await seed({
      name: 'org',
      spaceSlug: 'brand',
      content: 'granted material',
      embedding: between(0, 1),
    });

    const withheld = await harness.prisma.knowledgeSpace.create({
      data: {
        organizationId: granted.organizationId,
        slug: 'support-archive',
        name: 'support-archive',
      },
      select: { id: true },
    });
    const withheldDocument = await harness.prisma.knowledgeDocument.create({
      data: {
        organizationId: granted.organizationId,
        spaceId: withheld.id,
        title: 'withheld',
        checksum: 'test-checksum',
      },
      select: { id: true },
    });
    const withheldChunk = await harness.prisma.knowledgeChunk.create({
      data: {
        organizationId: granted.organizationId,
        spaceId: withheld.id,
        documentId: withheldDocument.id,
        ordinal: 0,
        content: 'withheld material, an exact match',
      },
      select: { id: true },
    });

    await writer.setEmbedding({
      chunkId: withheldChunk.id,
      organizationId: granted.organizationId,
      embedding: QUERY,
      model: MODEL,
    });

    const results = await retrieval.search({
      organizationId: granted.organizationId,
      spaceIds: [granted.spaceId],
      embedding: QUERY,
      embeddingModel: MODEL,
      limit: 10,
    });

    expect(results.map((match) => match.chunkId)).toEqual([granted.chunk.id]);
  });

  /**
   * Ranking, proved separately from scoping, so a query that returns the right
   * *set* in the wrong order is still a failure. Retrieval that ignores
   * distance would satisfy every isolation assertion above.
   */
  it('returns the closest chunks first', async () => {
    const base = await seed({
      name: 'ranked',
      spaceSlug: 'brand',
      content: 'far',
      embedding: axis(1),
    });

    const document = await harness.prisma.knowledgeDocument.create({
      data: {
        organizationId: base.organizationId,
        spaceId: base.spaceId,
        title: 'near',
        checksum: 'test-checksum',
      },
      select: { id: true },
    });
    const near = await harness.prisma.knowledgeChunk.create({
      data: {
        organizationId: base.organizationId,
        spaceId: base.spaceId,
        documentId: document.id,
        ordinal: 0,
        content: 'near',
      },
      select: { id: true },
    });

    await writer.setEmbedding({
      chunkId: near.id,
      organizationId: base.organizationId,
      embedding: QUERY,
      model: MODEL,
    });

    const results = await retrieval.search({
      organizationId: base.organizationId,
      spaceIds: [base.spaceId],
      embedding: QUERY,
      embeddingModel: MODEL,
      limit: 10,
    });

    expect(results.map((match) => match.content)).toEqual(['near', 'far']);
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 1);
  });

  /**
   * A chunk with no vector is not a zero vector, which would be an
   * equidistant match to everything and would pollute every result set.
   */
  it('ignores a chunk that has not been embedded yet', async () => {
    const base = await seed({
      name: 'pending',
      spaceSlug: 'brand',
      content: 'embedded',
      embedding: QUERY,
    });

    const document = await harness.prisma.knowledgeDocument.create({
      data: {
        organizationId: base.organizationId,
        spaceId: base.spaceId,
        title: 'not embedded',
        checksum: 'test-checksum',
      },
      select: { id: true },
    });
    await harness.prisma.knowledgeChunk.create({
      data: {
        organizationId: base.organizationId,
        spaceId: base.spaceId,
        documentId: document.id,
        ordinal: 0,
        content: 'not embedded',
      },
    });

    const results = await retrieval.search({
      organizationId: base.organizationId,
      spaceIds: [base.spaceId],
      embedding: QUERY,
      embeddingModel: MODEL,
      limit: 10,
    });

    expect(results.map((match) => match.content)).toEqual(['embedded']);
  });

  /**
   * The isolation guarantee, enforced by PostgreSQL rather than by whoever
   * writes the row.
   *
   * `knowledge_chunk.organizationId` *is* the scoping predicate. With three
   * independent foreign keys, a chunk claiming one organization while sitting
   * in another's space would insert happily, and the boundary would hold only
   * as far as every future ingestion path is correct. The composite keys make
   * that row impossible, so this asserts the constraint exists rather than
   * trusting the schema comment that says it does.
   */
  it('refuses a chunk whose organization disagrees with its space', async () => {
    const mine = await seed({
      name: 'mine',
      spaceSlug: 'brand',
      content: 'mine',
      embedding: QUERY,
    });
    const theirs = await seed({
      name: 'theirs',
      spaceSlug: 'brand',
      content: 'theirs',
      embedding: axis(1),
    });

    await expect(
      harness.prisma.knowledgeChunk.create({
        data: {
          // Claims to be mine...
          organizationId: mine.organizationId,
          // ...while filed in their space and their document.
          spaceId: theirs.spaceId,
          documentId: theirs.documentId,
          ordinal: 99,
          content: 'a row that should not exist',
        },
      }),
    ).rejects.toThrow();
  });

  it('refuses a document filed into another organization’s space', async () => {
    const mine = await seed({
      name: 'mine',
      spaceSlug: 'brand',
      content: 'mine',
      embedding: QUERY,
    });
    const theirs = await seed({
      name: 'theirs',
      spaceSlug: 'brand',
      content: 'theirs',
      embedding: axis(1),
    });

    await expect(
      harness.prisma.knowledgeDocument.create({
        data: {
          organizationId: mine.organizationId,
          spaceId: theirs.spaceId,
          title: 'a document that should not exist',
          checksum: 'test-checksum',
        },
      }),
    ).rejects.toThrow();
  });

  /**
   * The write side is scoped too. A chunk id from another organization must
   * not be embeddable, and the caller must be able to tell that nothing
   * happened rather than assuming success.
   */
  it('refuses to embed a chunk belonging to another organization', async () => {
    const mine = await seed({
      name: 'mine',
      spaceSlug: 'brand',
      content: 'mine',
      embedding: QUERY,
    });
    const theirs = await seed({
      name: 'theirs',
      spaceSlug: 'brand',
      content: 'theirs',
      embedding: axis(1),
    });

    const wrote = await writer.setEmbedding({
      chunkId: theirs.chunk.id,
      organizationId: mine.organizationId,
      embedding: QUERY,
      model: MODEL,
    });

    expect(wrote).toBe(false);

    // And their chunk still holds what it held.
    const stillTheirs = await retrieval.search({
      organizationId: theirs.organizationId,
      spaceIds: [theirs.spaceId],
      embedding: axis(1),
      embeddingModel: MODEL,
      limit: 10,
    });

    expect(stillTheirs[0]?.score).toBeCloseTo(1, 5);
  });

  /**
   * More than one granted space, against real SQL.
   *
   * Every other search here passes a single space id, so `= ANY($n::text[])`
   * is never exercised with more than one element — and replacing it with
   * `= $spaceIds[0]` passes the whole suite. The bug that ships is an agent
   * whose context policy resolves to three spaces reading only the first:
   * missing context, no error. This is also the only coverage of Prisma's
   * JS-array-to-`text[]` binding, which is what a driver or Prisma bump would
   * break.
   */
  it('reads every granted space, and still only the granted ones', async () => {
    const base = await seed({
      name: 'multi',
      spaceSlug: 'brand',
      content: 'from brand',
      embedding: between(0, 1),
    });

    const second = await harness.prisma.knowledgeSpace.create({
      data: {
        organizationId: base.organizationId,
        slug: 'product',
        name: 'product',
      },
      select: { id: true },
    });
    const secondDocument = await harness.prisma.knowledgeDocument.create({
      data: {
        organizationId: base.organizationId,
        spaceId: second.id,
        title: 'from product',
        checksum: 'test-checksum',
      },
      select: { id: true },
    });
    const secondChunk = await harness.prisma.knowledgeChunk.create({
      data: {
        organizationId: base.organizationId,
        spaceId: second.id,
        documentId: secondDocument.id,
        ordinal: 0,
        content: 'from product',
      },
      select: { id: true },
    });
    await writer.setEmbedding({
      chunkId: secondChunk.id,
      organizationId: base.organizationId,
      embedding: QUERY,
      model: MODEL,
    });

    const withheld = await harness.prisma.knowledgeSpace.create({
      data: {
        organizationId: base.organizationId,
        slug: 'withheld',
        name: 'withheld',
      },
      select: { id: true },
    });
    const withheldDocument = await harness.prisma.knowledgeDocument.create({
      data: {
        organizationId: base.organizationId,
        spaceId: withheld.id,
        title: 'withheld',
        checksum: 'test-checksum',
      },
      select: { id: true },
    });
    const withheldChunk = await harness.prisma.knowledgeChunk.create({
      data: {
        organizationId: base.organizationId,
        spaceId: withheld.id,
        documentId: withheldDocument.id,
        ordinal: 0,
        content: 'withheld',
      },
      select: { id: true },
    });
    await writer.setEmbedding({
      chunkId: withheldChunk.id,
      organizationId: base.organizationId,
      embedding: QUERY,
      model: MODEL,
    });

    const results = await retrieval.search({
      organizationId: base.organizationId,
      spaceIds: [base.spaceId, second.id],
      embedding: QUERY,
      embeddingModel: MODEL,
      limit: 10,
    });

    expect(results.map((match) => match.content).sort()).toEqual([
      'from brand',
      'from product',
    ]);
  });

  /**
   * Two models' embeddings occupy different spaces, and 1536 dimensions was
   * chosen so one model can replace another *without* a migration that stops
   * traffic — so the table holds both during re-embedding. Ranking across them
   * produces confident nonsense with no error, which is why the model is part
   * of the query rather than metadata.
   */
  it('ignores a chunk embedded by a different model', async () => {
    const base = await seed({
      name: 'models',
      spaceSlug: 'brand',
      content: 'current model',
      embedding: between(0, 1),
    });

    const document = await harness.prisma.knowledgeDocument.create({
      data: {
        organizationId: base.organizationId,
        spaceId: base.spaceId,
        title: 'old model',
        checksum: 'test-checksum',
      },
      select: { id: true },
    });
    const stale = await harness.prisma.knowledgeChunk.create({
      data: {
        organizationId: base.organizationId,
        spaceId: base.spaceId,
        documentId: document.id,
        ordinal: 0,
        content: 'old model, an exact match',
      },
      select: { id: true },
    });
    await writer.setEmbedding({
      chunkId: stale.id,
      organizationId: base.organizationId,
      embedding: QUERY,
      model: 'a-previous-embedding-model',
    });

    const results = await retrieval.search({
      organizationId: base.organizationId,
      spaceIds: [base.spaceId],
      embedding: QUERY,
      embeddingModel: MODEL,
      limit: 10,
    });

    expect(results.map((match) => match.content)).toEqual(['current model']);
  });

  /**
   * The ceiling has to survive the value an HTTP handler produces for any
   * non-numeric input. `Math.min(NaN, 12)` is `NaN`, the driver binds it as
   * SQL `NULL`, and `LIMIT NULL` means no limit — so this is the difference
   * between twelve chunks and the whole space.
   */
  it('refuses a limit that is not a whole number instead of dropping the ceiling', async () => {
    const base = await seed({
      name: 'nan',
      spaceSlug: 'brand',
      content: 'anything',
      embedding: QUERY,
    });

    await expect(
      retrieval.search({
        organizationId: base.organizationId,
        spaceIds: [base.spaceId],
        embedding: QUERY,
        embeddingModel: MODEL,
        limit: Number.NaN,
      }),
    ).rejects.toThrow(/whole number/);
  });

  it('caps a result set at the operator ceiling rather than the caller request', async () => {
    const base = await seed({
      name: 'capped',
      spaceSlug: 'brand',
      content: 'chunk 0',
      embedding: QUERY,
    });

    const document = await harness.prisma.knowledgeDocument.create({
      data: {
        organizationId: base.organizationId,
        spaceId: base.spaceId,
        title: 'more',
        checksum: 'test-checksum',
      },
      select: { id: true },
    });

    for (let ordinal = 0; ordinal < 20; ordinal += 1) {
      const chunk = await harness.prisma.knowledgeChunk.create({
        data: {
          organizationId: base.organizationId,
          spaceId: base.spaceId,
          documentId: document.id,
          ordinal,
          content: `extra ${ordinal}`,
        },
        select: { id: true },
      });

      await writer.setEmbedding({
        chunkId: chunk.id,
        organizationId: base.organizationId,
        embedding: QUERY,
        model: MODEL,
      });
    }

    const results = await retrieval.search({
      organizationId: base.organizationId,
      spaceIds: [base.spaceId],
      embedding: QUERY,
      embeddingModel: MODEL,
      limit: 1000,
    });

    // The registry default for `knowledge.retrieval_max_chunks`.
    expect(results).toHaveLength(12);
  });
});
