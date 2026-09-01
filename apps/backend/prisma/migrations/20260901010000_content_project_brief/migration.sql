-- The originating brief, snapshotted onto the content project.
--
-- Not additive in the usual sense: "topic" and "goal" are NOT NULL on a table
-- that already exists. That is safe here and is checked rather than assumed —
-- `content_project` was created by the immediately preceding migration in the
-- same unreleased change, so no deployed environment holds a row. The DO block
-- below refuses rather than guesses if that ever stops being true, because the
-- alternative is a migration that fails halfway with the columns already added.
--
-- Rollback compatibility holds: the preceding image ignores this table
-- entirely, and the two nullable columns need no default.

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
