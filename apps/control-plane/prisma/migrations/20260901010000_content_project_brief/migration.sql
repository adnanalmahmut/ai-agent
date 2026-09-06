-- The originating brief, snapshotted onto the content project.
--
-- Not additive in the usual sense: "topic" and "goal" are NOT NULL on a table
-- that already exists. That is safe here and is checked rather than assumed —
-- `content_project` was created by the immediately preceding migration in the
-- same unreleased change, so no deployed environment holds a row.
--
-- What the DO block buys is a legible refusal, not atomicity. PostgreSQL DDL is
-- transactional and the four ADD COLUMNs are one statement, so without the
-- guard a populated table would already fail cleanly and wholly, with
--   ERROR: column "topic" of relation "content_project" contains null values
-- The guard replaces that with a message naming the row count and the fact that
-- a backfill is what is missing, which is the difference between a migration
-- somebody has to reason about and one they can act on.
--
-- There is a window between the count and the ALTER in which a row could be
-- committed. That is not a hole: the ALTER then fails on the null values, which
-- is the same safe, whole rollback with the less helpful message.
--
-- Rollback compatibility: the last released image knows nothing of
-- `content_project`, so it ignores the table and its new columns alike. That
-- claim is about released images and not about intermediate commits of this
-- branch, whose earlier writer omits "topic" and "goal" and would violate the
-- NOT NULL — unreachable, because deployments are built from `main` merges.

DO $$
DECLARE
    existing bigint;
BEGIN
    SELECT count(*) INTO existing FROM "content_project";

    IF existing > 0 THEN
        RAISE EXCEPTION
            'content_project holds % row(s); adding NOT NULL brief columns needs an explicit backfill', existing;
    END IF;
END
$$;

-- AlterTable
ALTER TABLE "content_project"
    ADD COLUMN "topic" TEXT NOT NULL,
    ADD COLUMN "goal" TEXT NOT NULL,
    ADD COLUMN "audience" TEXT,
    ADD COLUMN "guidance" TEXT;
