-- Append-only history for control-plane mutations.
--
-- Additive only: one new table and three indexes, no change to any existing
-- object. Nothing reads it until the application that writes it is deployed, so
-- this is expand-safe and an earlier build rolled back onto this schema keeps
-- working — the table simply stays empty.
--
-- There is deliberately no foreign key to "user". An audit fact must not become
-- a reason a user row cannot be removed, and `ON DELETE SET NULL` would erase
-- the attribution the table exists to keep.

-- CreateTable
CREATE TABLE "control_plane_audit_event" (
    "id" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorUserId" TEXT,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resourceKey" TEXT NOT NULL,
    "organizationId" TEXT,
    "before" JSONB,
    "after" JSONB,

    CONSTRAINT "control_plane_audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "control_plane_audit_event_occurredAt_id_idx" ON "control_plane_audit_event"("occurredAt", "id");

-- CreateIndex
CREATE INDEX "control_plane_audit_event_resource_resourceKey_occurredAt_idx" ON "control_plane_audit_event"("resource", "resourceKey", "occurredAt");

-- CreateIndex
CREATE INDEX "control_plane_audit_event_organizationId_occurredAt_idx" ON "control_plane_audit_event"("organizationId", "occurredAt");
