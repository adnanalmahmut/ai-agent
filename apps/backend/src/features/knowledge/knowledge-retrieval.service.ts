import { Inject, Injectable } from '@nestjs/common';

import { RuntimeConfigResolver } from '../control-plane';
import type { EmbeddingVector, KnowledgeMatch } from './knowledge.types';
import { RETRIEVAL_PORT, type RetrievalPort } from './ports/retrieval.port';

/**
 * The question a feature actually asks: "what of this organization's material
 * bears on this, within the spaces it is allowed to see?"
 *
 * Thin on purpose. It exists for two things the adapter must not decide: the
 * operator-owned ceiling on how much may be returned, and the rule that an
 * empty space list retrieves nothing. Both belong to the application.
 */
@Injectable()
export class KnowledgeRetrievalService {
  constructor(
    @Inject(RETRIEVAL_PORT) private readonly retrieval: RetrievalPort,
    private readonly runtimeConfig: RuntimeConfigResolver,
  ) {}

  /**
   * `spaceIds` is what the caller is permitted to read — for an agent, its
   * code-owned context policy resolved to ids. It is not a filter the caller
   * may widen, and it is required: there is no "search everything" call to
   * reach for by accident.
   *
   * `limit` is a request, not a grant. The operator-owned
   * `knowledge.retrieval_max_chunks` is the ceiling, because how much context
   * a run may pull is an operational cost decision and belongs to whoever
   * pays the provider bill — not to the caller.
   */
  async search(input: {
    organizationId: string;
    spaceIds: readonly string[];
    embedding: EmbeddingVector;
    embeddingModel: string;
    limit?: number;
  }): Promise<KnowledgeMatch[]> {
    /**
     * The empty-policy rule lives here, not only in the adapter.
     *
     * `RetrievalPort` exists so the storage engine is replaceable, and a
     * second implementation that satisfied the port's stated obligations while
     * omitting this short-circuit would read every space in the organization.
     * The rule is the application's, so the application enforces it and the
     * port merely restates it for implementors.
     */
    if (input.spaceIds.length === 0) return [];

    const ceiling = await this.runtimeConfig.setting(
      'knowledge.retrieval_max_chunks',
    );
    const requested = input.limit ?? ceiling;

    /**
     * Refused rather than clamped. `Math.min(NaN, ceiling)` is `NaN`, which the
     * driver binds as SQL `NULL` — and `LIMIT NULL` means *no limit*, so the
     * operator ceiling would be bypassed by the one value an HTTP handler
     * produces for any non-numeric input. Clamping cannot express "this is not
     * a number"; refusing can.
     */
    if (!Number.isSafeInteger(requested)) {
      throw new Error('A knowledge retrieval limit must be a whole number');
    }

    return this.retrieval.search({
      organizationId: input.organizationId,
      spaceIds: input.spaceIds,
      embedding: input.embedding,
      embeddingModel: input.embeddingModel,
      limit: Math.max(0, Math.min(requested, ceiling)),
    });
  }
}
