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
} from '../../../src/features/knowledge';
import { createHarness, type Harness } from '../../support/auth-harness';

const axis = (index: number, magnitude = 1): number[] => {
  const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);
  vector[index] = magnitude;

  return vector;
};

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
    await harness.prisma.knowledgeSpace.deleteMany({
      where: { organizationId: { in: created.organizations } },
    });
    await harness.prisma.organization.deleteMany({
      where: { id: { in: created.organizations } },
    });
    created.organizations = [];
  });

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

    const results = await retrieval.search({
      organizationId: mine.organizationId,
      spaceIds: [mine.spaceId, theirs.spaceId],
      embedding: QUERY,
      embeddingModel: MODEL,
      limit: 10,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.chunkId).toBe(mine.chunk.id);
    expect(results[0]?.spaceId).toBe(mine.spaceId);
    expect(results[0]?.documentId).toBe(mine.documentId);
    expect(results.map((match) => match.content)).not.toContain(
      'their material, an exact match',
    );

    const other = await retrieval.search({
      organizationId: theirs.organizationId,
      spaceIds: [mine.spaceId, theirs.spaceId],
      embedding: QUERY,
      embeddingModel: MODEL,
      limit: 10,
    });

    expect(other.map((match) => match.chunkId)).toEqual([theirs.chunk.id]);
  });

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
          organizationId: mine.organizationId,
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

    const stillTheirs = await retrieval.search({
      organizationId: theirs.organizationId,
      spaceIds: [theirs.spaceId],
      embedding: axis(1),
      embeddingModel: MODEL,
      limit: 10,
    });

    expect(stillTheirs[0]?.score).toBeCloseTo(1, 5);
  });

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

    expect(results).toHaveLength(12);
  });
});
