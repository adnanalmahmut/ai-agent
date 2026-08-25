-- The platform must always keep at least one usable super administrator.
--
-- ## Why this is a trigger rather than only application code
--
-- The invariant spans a read and a write: count the usable super administrators,
-- then make one of them unusable. Under PostgreSQL's default isolation two such
-- transactions interleave freely — each reads "two", each proceeds, and the
-- platform is left with none. No ordering of application statements fixes that,
-- and the writes do not all come from one place: this application's own routes
-- and Better Auth's admin plugin write the same rows through different
-- transactions.
--
-- A trigger sits under all of them, including any route a future Better Auth
-- version adds. `pg_advisory_xact_lock` is what makes it exact: the second
-- transaction blocks until the first commits, then re-reads the committed state
-- and sees zero. The application still asks the same question before writing —
-- see `super-admin-floor.ts` — so the ordinary, uncontended case is answered
-- with a 409 and a sentence rather than a database exception.
--
-- ## Why the lock is taken late
--
-- Only when a row that *was* a usable super administrator stops being one. A
-- lock taken on every user update would serialize all user writes platform-wide
-- to protect an invariant almost none of them can violate.
--
-- ## What "usable" means
--
-- Holding the `super_admin` role is not enough: a banned account cannot
-- authenticate and a deactivated one is refused a session by the application's
-- own hook, so either leaves nobody able to reach the control plane or appoint a
-- replacement. The three conditions here are the same three
-- `isUsableSuperAdmin` applies in TypeScript.
--
-- Roles are stored comma-separated, so membership is an array test rather than a
-- LIKE: `%super_admin%` would also match a role named `not_super_admin`.
--
-- ## What it deliberately does not cover
--
-- INSERT, so the `super-admin:create` bootstrap command is untouched and the
-- host-access trust boundary it relies on is unchanged.
--
-- DELETE, which is a decision rather than an oversight. This application never
-- hard-deletes a user: `user:delete` is granted to no role in `permissions.ts`,
-- `/admin/remove-user` is unreachable, and `auth-boundaries.spec.ts` asserts
-- that no source file calls it. Every mutation that can actually make a super
-- administrator unusable — set-role, ban-user, update-user, and the
-- application's own deactivation — is an UPDATE, so UPDATE is complete coverage
-- of every reachable path.
--
-- What a DELETE branch would guard is therefore only somebody with direct
-- database access, and that is the *recovery* channel rather than an attack: it
-- is how the runbook un-wedges a platform and how the bootstrap command runs.
-- Blocking it leaves an operator who must remove a row — an erasure request,
-- say — with no path at all, and a runbook whose answer is "drop the trigger",
-- which is worse than the problem. The application layer still refuses
-- `/admin/remove-user` for the last usable administrator through
-- `SUPER_ADMIN_GUARDED_PATHS`, so the door stays shut if `user:delete` is ever
-- granted.

CREATE OR REPLACE FUNCTION enforce_super_admin_floor() RETURNS TRIGGER AS $$
DECLARE
  -- Distinct from the agent-run acceptance lock (4310001). Advisory locks share
  -- one global space, so every lock in this application takes its own namespace.
  lock_namespace CONSTANT integer := 4310003;
  remaining integer;
BEGIN
  -- Was the row a usable super administrator before this statement?
  IF NOT (
    'super_admin' = ANY(string_to_array(replace(coalesce(OLD.role, ''), ' ', ''), ','))
    AND coalesce(OLD.banned, false) = false
    AND OLD."deletedAt" IS NULL
  ) THEN
    RETURN NULL;
  END IF;

  -- Is it still one after it? An update that leaves the account usable — a
  -- changed name, a new password, a promotion — is not this trigger's business.
  IF (
    'super_admin' = ANY(string_to_array(replace(coalesce(NEW.role, ''), ' ', ''), ','))
    AND coalesce(NEW.banned, false) = false
    AND NEW."deletedAt" IS NULL
  ) THEN
    RETURN NULL;
  END IF;

  PERFORM pg_advisory_xact_lock(lock_namespace, 0);

  SELECT count(*) INTO remaining
  FROM "user"
  WHERE 'super_admin' = ANY(string_to_array(replace(coalesce(role, ''), ' ', ''), ','))
    AND coalesce(banned, false) = false
    AND "deletedAt" IS NULL;

  IF remaining = 0 THEN
    -- The message carries a fixed sentinel the application matches on, so a
    -- transaction that loses the race is translated into the same 409 the
    -- pre-check produces rather than escaping as a 500.
    RAISE EXCEPTION 'super_admin_floor_violation: the platform must keep at least one usable super administrator';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- AFTER, not BEFORE: the count above must see this statement's own effect, and
-- a BEFORE trigger runs while the row still holds its old values.
--
-- A constraint trigger deferred to commit was the alternative and is worse here:
-- it would report the violation at COMMIT, after the application had already
-- returned, which is precisely when nothing is left to translate it.
CREATE TRIGGER enforce_super_admin_floor_trigger
AFTER UPDATE ON "user"
FOR EACH ROW
EXECUTE FUNCTION enforce_super_admin_floor();
