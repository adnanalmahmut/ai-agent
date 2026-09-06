-- Knowledge management: re-ingestion as an update rather than a duplicate.
--
-- Additive. `revision` has a default so existing rows need no backfill, and
-- the unique index is over columns that already exist. Both are safe for a
-- previous release running beside this one: an older build simply never reads
-- the counter, and it already wrote one document per title in practice.
--
-- The unique index is what makes a re-submitted source an update. Without it,
-- ingesting the same document twice creates a second copy, and retrieval then
-- returns the same passage twice — filling an agent's context budget with a
-- duplicate instead of with something else the organization knows.


-- AlterTable
ALTER TABLE "knowledge_document" ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_document_organizationId_spaceId_title_key" ON "knowledge_document"("organizationId", "spaceId", "title");

