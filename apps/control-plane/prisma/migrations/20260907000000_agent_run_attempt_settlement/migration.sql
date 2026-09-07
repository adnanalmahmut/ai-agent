-- Record which execution attempt has already had a result accepted, and a
-- digest of what was accepted, so at most one result per (run, attempt) can be
-- applied and a replay of that same result is distinguishable from a
-- contradiction.
--
-- Nullable expansion only: the preceding image neither reads nor writes these
-- columns, so a rolling deployment or a rollback keeps working. The digest is a
-- SHA-256 hex string of the accepted result, never the result itself and never
-- any text the reporter chose.

-- AlterTable
ALTER TABLE "agent_run"
  ADD COLUMN "settledAttempt" INTEGER,
  ADD COLUMN "settledResultDigest" TEXT;
