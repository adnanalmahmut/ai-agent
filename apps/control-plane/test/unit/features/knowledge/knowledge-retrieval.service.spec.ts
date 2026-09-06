import { describe, expect, it, jest } from '@jest/globals';

import { KnowledgeRetrievalService } from '../../../../src/features/knowledge/knowledge-retrieval.service';
import { EMBEDDING_DIMENSIONS } from '../../../../src/features/knowledge/knowledge.types';
import type { RetrievalPort } from '../../../../src/features/knowledge/ports/retrieval.port';
import type { RetrievalQuery } from '../../../../src/features/knowledge/knowledge.types';

const embedding = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.1);
const MODEL = 'test-embedding-model';

const portRecording = () => {
  const calls: RetrievalQuery[] = [];
  const port: RetrievalPort = {
    search: (query) => {
      calls.push(query);

      return Promise.resolve([]);
    },
  };

  return { port, calls };
};

const resolverWithCeiling = (ceiling: number) =>
  ({
    setting: jest.fn(() => Promise.resolve(ceiling)),
  }) as unknown as ConstructorParameters<typeof KnowledgeRetrievalService>[1];

describe('KnowledgeRetrievalService', () => {
  it('passes the caller organization and spaces through untouched', async () => {
    const { port, calls } = portRecording();
    const service = new KnowledgeRetrievalService(
      port,
      resolverWithCeiling(12),
    );

    await service.search({
      organizationId: 'org_a',
      spaceIds: ['space_1', 'space_2'],
      embedding,
      embeddingModel: MODEL,
    });

    expect(calls[0]?.organizationId).toBe('org_a');
    expect(calls[0]?.spaceIds).toEqual(['space_1', 'space_2']);
  });

  it('clamps a request to the operator ceiling', async () => {
    const { port, calls } = portRecording();
    const service = new KnowledgeRetrievalService(port, resolverWithCeiling(5));

    await service.search({
      organizationId: 'org_a',
      spaceIds: ['space_1'],
      embedding,
      embeddingModel: MODEL,
      limit: 500,
    });

    expect(calls[0]?.limit).toBe(5);
  });

  it('honours a request below the ceiling', async () => {
    const { port, calls } = portRecording();
    const service = new KnowledgeRetrievalService(
      port,
      resolverWithCeiling(12),
    );

    await service.search({
      organizationId: 'org_a',
      spaceIds: ['space_1'],
      embedding,
      embeddingModel: MODEL,
      limit: 3,
    });

    expect(calls[0]?.limit).toBe(3);
  });

  it('falls back to the ceiling when the caller asks for no particular number', async () => {
    const { port, calls } = portRecording();
    const service = new KnowledgeRetrievalService(port, resolverWithCeiling(7));

    await service.search({
      organizationId: 'org_a',
      spaceIds: ['space_1'],
      embedding,
      embeddingModel: MODEL,
    });

    expect(calls[0]?.limit).toBe(7);
  });

  it('never asks for a negative number of chunks', async () => {
    const { port, calls } = portRecording();
    const service = new KnowledgeRetrievalService(
      port,
      resolverWithCeiling(12),
    );

    await service.search({
      organizationId: 'org_a',
      spaceIds: ['space_1'],
      embedding,
      embeddingModel: MODEL,
      limit: -5,
    });

    expect(calls[0]?.limit).toBe(0);
  });

  it.each([NaN, Infinity, -Infinity, 2.5])(
    'refuses a limit of %p rather than clamping it',
    async (limit) => {
      const { port, calls } = portRecording();
      const service = new KnowledgeRetrievalService(
        port,
        resolverWithCeiling(12),
      );

      await expect(
        service.search({
          organizationId: 'org_a',
          spaceIds: ['space_1'],
          embedding,
          embeddingModel: MODEL,
          limit,
        }),
      ).rejects.toThrow(/whole number/);

      expect(calls).toHaveLength(0);
    },
  );

  it('asks nothing when no space was granted', async () => {
    const { port, calls } = portRecording();
    const service = new KnowledgeRetrievalService(
      port,
      resolverWithCeiling(12),
    );

    await expect(
      service.search({
        organizationId: 'org_a',
        spaceIds: [],
        embedding,
        embeddingModel: MODEL,
      }),
    ).resolves.toEqual([]);

    expect(calls).toHaveLength(0);
  });

  it('passes the model the query was embedded with', async () => {
    const { port, calls } = portRecording();
    const service = new KnowledgeRetrievalService(
      port,
      resolverWithCeiling(12),
    );

    await service.search({
      organizationId: 'org_a',
      spaceIds: ['space_1'],
      embedding,
      embeddingModel: 'text-embedding-3-large',
    });

    expect(calls[0]?.embeddingModel).toBe('text-embedding-3-large');
  });

  it('reads the ceiling on every search', async () => {
    const { port } = portRecording();
    const resolver = resolverWithCeiling(12);
    const service = new KnowledgeRetrievalService(port, resolver);

    await service.search({
      organizationId: 'a',
      spaceIds: ['s'],
      embedding,
      embeddingModel: MODEL,
    });
    await service.search({
      organizationId: 'a',
      spaceIds: ['s'],
      embedding,
      embeddingModel: MODEL,
    });

    expect(
      (resolver as unknown as { setting: jest.Mock }).setting,
    ).toHaveBeenCalledTimes(2);
  });
});
