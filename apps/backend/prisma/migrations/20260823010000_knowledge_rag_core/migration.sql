-- Knowledge: organization-owned reference material, chunked and embedded.
--
-- Additive and forward-only. Nothing existing is altered, so an older release
-- runs unchanged against this schema and a rollback needs no contraction.
--
-- The extension is created here rather than through Prisma's
-- `postgresqlExtensions` preview feature, which was deprecated in 6.16.0 and
-- is absent from current documentation even though the installed 7.9.1 CLI
-- still accepts it. `IF NOT EXISTS` so re-running on a database that already
-- has it is a no-op rather than an error.
--
-- There is deliberately no index on `knowledge_chunk.embedding`. An
-- approximate index applies the tenant predicate *after* the index scan, so a
-- scoped query silently returns fewer rows than asked for; and Prisma cannot
-- represent HNSW or IVFFlat, so it emits `DROP INDEX` for one on every
-- subsequent migration. Exact search needs no index. The btree on
-- `(organizationId, spaceId)` is what serves the scoping predicate.
--
-- The composite foreign keys are the isolation guarantee made structural.
-- `knowledge_chunk.organizationId` is the whole scoping predicate, so three
-- independent single-column references would leave the three tenant answers
-- agreeing only as far as whatever writes the row is correct. Referencing
-- `(spaceId, organizationId)` and `(documentId, organizationId)` as pairs makes
-- a chunk that claims one organization while sitting in another's space a
-- constraint violation instead of a silent leak waiting for a caller.

CREATE EXTENSION IF NOT EXISTS vector;


-- CreateTable
CREATE TABLE "knowledge_space" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_space_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_document" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sourceUri" TEXT,
    "checksum" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_chunk" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1536),
    "embeddingModel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_chunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "knowledge_space_organizationId_idx" ON "knowledge_space"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_space_organizationId_slug_key" ON "knowledge_space"("organizationId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_space_id_organizationId_key" ON "knowledge_space"("id", "organizationId");

-- CreateIndex
CREATE INDEX "knowledge_document_organizationId_idx" ON "knowledge_document"("organizationId");

-- CreateIndex
CREATE INDEX "knowledge_document_spaceId_idx" ON "knowledge_document"("spaceId");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_document_id_organizationId_key" ON "knowledge_document"("id", "organizationId");

-- CreateIndex
CREATE INDEX "knowledge_chunk_organizationId_spaceId_idx" ON "knowledge_chunk"("organizationId", "spaceId");

-- CreateIndex
CREATE INDEX "knowledge_chunk_documentId_idx" ON "knowledge_chunk"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_chunk_documentId_ordinal_key" ON "knowledge_chunk"("documentId", "ordinal");

-- AddForeignKey
ALTER TABLE "knowledge_space" ADD CONSTRAINT "knowledge_space_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_document" ADD CONSTRAINT "knowledge_document_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_document" ADD CONSTRAINT "knowledge_document_spaceId_organizationId_fkey" FOREIGN KEY ("spaceId", "organizationId") REFERENCES "knowledge_space"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_chunk" ADD CONSTRAINT "knowledge_chunk_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_chunk" ADD CONSTRAINT "knowledge_chunk_spaceId_organizationId_fkey" FOREIGN KEY ("spaceId", "organizationId") REFERENCES "knowledge_space"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_chunk" ADD CONSTRAINT "knowledge_chunk_documentId_organizationId_fkey" FOREIGN KEY ("documentId", "organizationId") REFERENCES "knowledge_document"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

