import { describe, expect, it, jest } from '@jest/globals';

import { AgentContextAssembler } from '../../../../src/features/knowledge/agent-context.assembler';
import type { ContextPolicy } from '../../../../src/ai/agents/agent.types';

/**
 * What an agent is allowed to be given.
 *
 * The database and the vector search are exercised end to end elsewhere; what
 * is asserted here is the part that decides *whether* to search at all and
 * *how much* of the answer survives — the branches that are easy to get right
 * once and then lose to a refactor, because none of them fails loudly.
 */

const passage = (content: string, spaceId = 'space_brand') => ({
  chunkId: `chunk_${content.length}_${spaceId}`,
  documentId: 'doc_1',
  spaceId,
  content,
  score: 0.9,
});

const build = (
  options: {
    spaces?: { id: string; slug: string }[];
    matches?: ReturnType<typeof passage>[];
  } = {},
) => {
  const resolveSlugs = jest.fn<
    (args?: unknown) => Promise<{ id: string; slug: string }[]>
  >(() => Promise.resolve(options.spaces ?? []));
  const search = jest.fn<
    (args?: unknown) => Promise<ReturnType<typeof passage>[]>
  >(() => Promise.resolve(options.matches ?? []));
  const embed = jest.fn<(texts?: unknown) => Promise<number[][]>>(() =>
    Promise.resolve([[1, 0, 0]]),
  );

  const assembler = new AgentContextAssembler(
    { resolveSlugs } as unknown as never,
    { search } as unknown as never,
    { model: 'model-a', dimensions: 3, maxBatch: 8, embed },
  );

  return { assembler, resolveSlugs, search, embed };
};

const policy = (overrides: Partial<ContextPolicy> = {}): ContextPolicy => ({
  spaceSlugs: ['brand.voice'],
  maxChunks: 5,
  maxCharacters: 1_000,
  ...overrides,
});

describe('AgentContextAssembler', () => {
  /**
   * No policy is no context, and it must cost nothing to establish that. An
   * agent that did not declare what it may read does not get "everything" as
   * a default, and it should not spend an embedding call discovering so.
   */
  it('retrieves nothing for an agent with no context policy', async () => {
    const { assembler, resolveSlugs, embed, search } = build();

    await expect(
      assembler.assemble({
        organizationId: 'org_1',
        policy: undefined,
        query: 'anything',
      }),
    ).resolves.toEqual([]);

    expect(resolveSlugs).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it('retrieves nothing for a policy that names no spaces', async () => {
    const { assembler, embed } = build();

    await expect(
      assembler.assemble({
        organizationId: 'org_1',
        policy: policy({ spaceSlugs: [] }),
        query: 'anything',
      }),
    ).resolves.toEqual([]);

    expect(embed).not.toHaveBeenCalled();
  });

  it('does not embed an empty query', async () => {
    const { assembler, embed } = build({
      spaces: [{ id: 'space_brand', slug: 'brand.voice' }],
    });

    await expect(
      assembler.assemble({
        organizationId: 'org_1',
        policy: policy(),
        query: '   ',
      }),
    ).resolves.toEqual([]);

    expect(embed).not.toHaveBeenCalled();
  });

  /**
   * The policy names slugs; the slugs are resolved against the caller's own
   * organization. This is what keeps a definition from being able to name its
   * way into another tenant's material.
   */
  it('resolves policy slugs only within the calling organization', async () => {
    const { assembler, resolveSlugs, search } = build({
      spaces: [{ id: 'space_brand', slug: 'brand.voice' }],
      matches: [passage('Brand voice is plain.')],
    });

    await assembler.assemble({
      organizationId: 'org_1',
      policy: policy({ spaceSlugs: ['brand.voice', 'products.services'] }),
      query: 'tone',
    });

    expect(resolveSlugs).toHaveBeenCalledWith({
      organizationId: 'org_1',
      slugs: ['brand.voice', 'products.services'],
    });

    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_1',
        spaceIds: ['space_brand'],
      }),
    );
  });

  it('retrieves nothing when the policy names no space this organization has', async () => {
    const { assembler, search, embed } = build({ spaces: [] });

    await expect(
      assembler.assemble({
        organizationId: 'org_1',
        policy: policy({ spaceSlugs: ['design.system'] }),
        query: 'tone',
      }),
    ).resolves.toEqual([]);

    expect(embed).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it('searches with the model the chunks were embedded with', async () => {
    const { assembler, search } = build({
      spaces: [{ id: 'space_brand', slug: 'brand.voice' }],
    });

    await assembler.assemble({
      organizationId: 'org_1',
      policy: policy(),
      query: 'tone',
    });

    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ embeddingModel: 'model-a' }),
    );
  });

  /**
   * The policy's number, not a constant that happens to equal it. Every other
   * case here uses the default, so a hardcoded limit would read as correct.
   */
  it('takes the chunk ceiling from the policy', async () => {
    const { assembler, search } = build({
      spaces: [{ id: 'space_brand', slug: 'brand.voice' }],
    });

    await assembler.assemble({
      organizationId: 'org_1',
      policy: policy({ maxChunks: 3 }),
      query: 'tone',
    });

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ limit: 3 }));
  });

  /**
   * What the vector is made of.
   *
   * Nothing else asserts the embedder's argument, so embedding the untrimmed
   * string — or the policy's slugs, or an empty array — passes the whole
   * suite: `search` is a double that returns its fixtures whatever it is
   * given, so retrieval degrades to noise without a single failure.
   */
  it('embeds the trimmed query itself', async () => {
    const { assembler, embed } = build({
      spaces: [{ id: 'space_brand', slug: 'brand.voice' }],
    });

    await assembler.assemble({
      organizationId: 'org_1',
      policy: policy(),
      query: '  what is our tone  ',
    });

    expect(embed).toHaveBeenCalledWith(['what is our tone']);
  });

  it('searches with the vector it just embedded', async () => {
    const { assembler, search } = build({
      spaces: [{ id: 'space_brand', slug: 'brand.voice' }],
    });

    await assembler.assemble({
      organizationId: 'org_1',
      policy: policy(),
      query: 'tone',
    });

    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ embedding: [1, 0, 0] }),
    );
  });

  it('labels each passage with the space it came from', async () => {
    const { assembler } = build({
      spaces: [
        { id: 'space_brand', slug: 'brand.voice' },
        { id: 'space_products', slug: 'products.services' },
      ],
      matches: [
        passage('Voice is plain.', 'space_brand'),
        passage('The kettle boils fast.', 'space_products'),
      ],
    });

    await expect(
      assembler.assemble({
        organizationId: 'org_1',
        policy: policy({ spaceSlugs: ['brand.voice', 'products.services'] }),
        query: 'tone',
      }),
    ).resolves.toEqual([
      { space: 'brand.voice', content: 'Voice is plain.' },
      { space: 'products.services', content: 'The kettle boils fast.' },
    ]);
  });

  describe('the character budget', () => {
    /**
     * Whole passages only. Half a paragraph reads as a complete thought that
     * happens to end early, and neither the model nor a reader checking the
     * answer can tell that something was cut.
     */
    it('drops passages rather than truncating them', async () => {
      const { assembler } = build({
        spaces: [{ id: 'space_brand', slug: 'brand.voice' }],
        matches: [passage('a'.repeat(60)), passage('b'.repeat(60))],
      });

      const assembled = await assembler.assemble({
        organizationId: 'org_1',
        policy: policy({ maxCharacters: 100 }),
        query: 'tone',
      });

      expect(assembled).toHaveLength(1);
      expect(assembled[0]?.content).toBe('a'.repeat(60));
    });

    /**
     * One long document must not hide every shorter passage ranked behind it.
     * Skipping over an oversized passage rather than stopping is the
     * difference between a thin context and an empty one.
     */
    it('keeps a later passage that still fits', async () => {
      const { assembler } = build({
        spaces: [{ id: 'space_brand', slug: 'brand.voice' }],
        matches: [passage('a'.repeat(200)), passage('b'.repeat(10))],
      });

      const assembled = await assembler.assemble({
        organizationId: 'org_1',
        policy: policy({ maxCharacters: 100 }),
        query: 'tone',
      });

      expect(assembled.map((entry) => entry.content)).toEqual(['b'.repeat(10)]);
    });

    it('keeps ranked order for everything that fits', async () => {
      const { assembler } = build({
        spaces: [{ id: 'space_brand', slug: 'brand.voice' }],
        matches: [passage('first'), passage('second'), passage('third')],
      });

      const assembled = await assembler.assemble({
        organizationId: 'org_1',
        policy: policy(),
        query: 'tone',
      });

      expect(assembled.map((entry) => entry.content)).toEqual([
        'first',
        'second',
        'third',
      ]);
    });
  });
});
