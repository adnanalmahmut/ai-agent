import type { EmbeddingVector } from '../knowledge.types';

export interface EmbeddingPort {
  readonly model: string;
  readonly dimensions: number;

  readonly maxBatch: number;

  embed(texts: readonly string[]): Promise<EmbeddingVector[]>;
}

export const EMBEDDING_PORT = Symbol('EMBEDDING_PORT');
