import type { EmbeddingVector } from '../knowledge.types';

/**
 * Turning text into a vector, as a contract rather than a provider.
 *
 * Declared here and implemented elsewhere on purpose. The dimension of the
 * column is a migration and a full re-embedding to change, so the port states
 * what the deployed schema requires and an adapter that cannot meet it fails
 * where it is constructed rather than on the first write.
 */
export interface EmbeddingPort {
  /** The model this adapter speaks for, recorded with what it produces. */
  readonly model: string;
  readonly dimensions: number;

  /**
   * Embeds in order: `embed(texts)[i]` is the vector for `texts[i]`.
   *
   * Batched because every provider charges and rate-limits per request, and a
   * per-chunk call turns one document into hundreds of them.
   */
  embed(texts: readonly string[]): Promise<EmbeddingVector[]>;
}

export const EMBEDDING_PORT = Symbol('EMBEDDING_PORT');
