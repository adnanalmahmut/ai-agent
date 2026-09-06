-- Session location is optional, server-generated metadata. Existing sessions
-- remain valid and receive NULL until a future sign-in creates a new session.
ALTER TABLE "session"
  ADD COLUMN "country" TEXT,
  ADD COLUMN "city" TEXT;
