-- Append-only organization-owned product history.
--
-- Additive only: an earlier ORG-01 build ignores this table, so rolling the
-- application back leaves durable history intact without breaking the older
-- schema contract.
--
-- `actorUserId` deliberately has no user foreign key. Attribution must survive
-- a future actor lifecycle change rather than blocking it or being erased by
-- `ON DELETE SET NULL`.

-- CreateTable
CREATE TABLE "organization_audit_event" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,

    CONSTRAINT "organization_audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "organization_audit_event_organizationId_occurredAt_id_idx" ON "organization_audit_event"("organizationId", "occurredAt", "id");

-- CreateIndex
CREATE INDEX "organization_audit_event_organizationId_subjectType_subjectId_occurredAt_idx" ON "organization_audit_event"("organizationId", "subjectType", "subjectId", "occurredAt");

-- AddForeignKey
ALTER TABLE "organization_audit_event" ADD CONSTRAINT "organization_audit_event_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Migration and application processes currently connect with the same
-- PostgreSQL role, so grants cannot distinguish the append writer from other
-- application queries. Keep immutability local to the table instead: every
-- UPDATE or DELETE fails regardless of whether it came through Prisma or raw
-- SQL, while INSERT and SELECT remain ordinary operations.
CREATE OR REPLACE FUNCTION refuse_organization_audit_event_mutation() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'organization_audit_event_append_only: UPDATE and DELETE are forbidden';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER organization_audit_event_append_only_trigger
BEFORE UPDATE OR DELETE ON "organization_audit_event"
FOR EACH ROW
EXECUTE FUNCTION refuse_organization_audit_event_mutation();
