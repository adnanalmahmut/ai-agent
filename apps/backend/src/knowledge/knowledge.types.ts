/**
 * The Knowledge domain's own vocabulary, independent of Prisma, of pgvector,
 * and of whichever provider produced the numbers.
 *
 * Kept separate for the reason the agent types are: the storage engine and the
 * embedding provider are both adapters, and a domain that spoke their types
 * would make replacing either a change to every caller.
 */

/**
 * One embedding, as plain numbers.
 *
 * The dimension is not encoded in the type — TypeScript cannot check the length
 * of a runtime array — so it is checked where it enters the system instead, by
 * the adapter that has to write it into a fixed-width column.
 */
export type EmbeddingVector = readonly number[];

/** The dimension the deployed schema was migrated for. */
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * What a caller may ask for.
 *
 * `organizationId` and `spaceIds` are both required and neither is optional,
 * because a retrieval with no tenant is not a broader search — it is a leak,
 * and an optional field is one `undefined` away from performing it.
 */
export type RetrievalQuery = {
  organizationId: string;
  /**
   * The model the query vector came from.
   *
   * Required, and matched against the stored `embeddingModel`, because two
   * models' embeddings are not comparable — the numbers are in different
   * spaces and the distance between them is arithmetic rather than meaning.
   * 1536 dimensions was chosen so `text-embedding-3-large` can replace
   * `text-embedding-3-small` without a column change, which means the swap
   * will *not* be forced through a migration that stops traffic: during
   * re-embedding the table holds both, and a query that ranked across them
   * would return confidently wrong distances and no error.
   */
  embeddingModel: string;
  /**
   * The spaces the caller is allowed to see, which for an agent is exactly its
   * declared `ContextPolicy`. An empty list retrieves nothing rather than
   * everything: "no spaces declared" must not mean "all spaces".
   */
  spaceIds: readonly string[];
  embedding: EmbeddingVector;
  limit: number;
};

/** One retrieved chunk, with the score that ranked it. */
export type KnowledgeMatch = {
  chunkId: string;
  documentId: string;
  spaceId: string;
  content: string;
  /**
   * Cosine similarity in `[-1, 1]`; higher is closer.
   *
   * Negative is not a bug and not a floor to clamp away: `<=>` is cosine
   * *distance* over `[0, 2]`, so `1 - distance` reaches `-1` for opposed text,
   * which real models do produce. A caller writing a relevance cut needs the
   * true range — a threshold chosen against a documented minimum of zero
   * discards far more than its author intended.
   */
  score: number;
};
