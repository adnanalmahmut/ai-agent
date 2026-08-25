import { describe, expect, it, jest } from '@jest/globals';

import { KnowledgeRetrievalService } from '../knowledge-retrieval.service';
import { EMBEDDING_DIMENSIONS } from '../knowledge.types';
import type { RetrievalPort } from '../ports/retrieval.port';
import type { RetrievalQuery } from '../knowledge.types';

/**
 * The two decisions this service exists to make, and one it must not make.
 *
 * Everything else about retrieval is the adapter's. What is here is the
 * operator's ceiling on how much may be returned and the rule that "no spaces"
 * means nothing rather than everything — both of which would be silently wrong
 * rather than loudly broken if they regressed.
 */

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

  /**
   * How much context a run may pull is an operational cost decision. A caller
   * that could exceed it would make the setting advisory, and the operator who
   * lowered it because of a provider bill would find it had no effect.
   */
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

  /**
   * The one clamp that cannot be a clamp.
   *
   * `Math.min(NaN, ceiling)` is `NaN`, the driver binds `NaN` as SQL `NULL`,
   * and `LIMIT NULL` in PostgreSQL means *no limit* — so the ceiling this
   * service exists to enforce would be bypassed by the value an HTTP handler
   * produces for any non-numeric query string. Refused, not clamped.
   */
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

  /**
   * The rule belongs to the application, not to whichever adapter happens to
   * be bound: a second `RetrievalPort` that satisfied the port's documented
   * obligations while dropping an empty list from its predicate would read the
   * whole organization.
   */
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

  /**
   * The setting is read per search rather than cached, for the same reason
   * nothing else in the control plane is cached: an operator who lowers a
   * limit expects the next run to respect it.
   */
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
