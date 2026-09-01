-- Content projects, their initial draft target, and the tenant-safe reference
-- back to the run an idea came from.
--
-- Additive only. The preceding image ignores both tables, so a rollback leaves
-- durable project history intact without breaking it. The new unique index on
-- "agent_run" is additive as well: it constrains nothing the application was
-- already allowed to write, because ("id") is already the primary key and
-- ("id", "organizationId") is therefore unique by construction. It exists so a
-- child table can reference the pair and have PostgreSQL refuse a selection
-- that crosses an organization boundary.

-- CreateIndex
-- The composite target that makes a tenant-safe child reference expressible.
CREATE UNIQUE INDEX "agent_run_id_organizationId_key" ON "agent_run"("id", "organizationId");

-- CreateTable
CREATE TABLE "content_project" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sourceRunId" TEXT NOT NULL,
    "sourceIdeaIndex" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "hook" TEXT NOT NULL,
    "angle" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "suggestedFormat" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_draft" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "body" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_draft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Durable request identity. A retried selection finds its own project instead
-- of creating a second one.
CREATE UNIQUE INDEX "content_project_organizationId_idempotencyKey_key" ON "content_project"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "content_project_id_organizationId_key" ON "content_project"("id", "organizationId");

-- CreateIndex
-- Serves the organization-scoped list: newest first, paginated by a stable
-- ("createdAt", "id") cursor.
CREATE INDEX "content_project_organizationId_createdAt_id_idx" ON "content_project"("organizationId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "content_project_sourceRunId_idx" ON "content_project"("sourceRunId");

-- CreateIndex
CREATE INDEX "content_project_createdByUserId_idx" ON "content_project"("createdByUserId");

-- CreateIndex
-- One row per revision within a project.
CREATE UNIQUE INDEX "content_draft_projectId_revision_key" ON "content_draft"("projectId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "content_draft_id_organizationId_key" ON "content_draft"("id", "organizationId");

-- CreateIndex
CREATE INDEX "content_draft_organizationId_idx" ON "content_draft"("organizationId");

-- CreateIndex
CREATE INDEX "content_draft_projectId_idx" ON "content_draft"("projectId");

-- CreateIndex
CREATE INDEX "content_draft_createdByUserId_idx" ON "content_draft"("createdByUserId");

-- AddForeignKey
ALTER TABLE "content_project" ADD CONSTRAINT "content_project_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- The pair, not the id alone. This is what makes a cross-organization
-- selection impossible rather than merely unimplemented: a row whose
-- "sourceRunId" belongs to another organization has no matching
-- ("id", "organizationId") in "agent_run" and the insert is refused.
ALTER TABLE "content_project" ADD CONSTRAINT "content_project_sourceRunId_organizationId_fkey" FOREIGN KEY ("sourceRunId", "organizationId") REFERENCES "agent_run"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_project" ADD CONSTRAINT "content_project_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_draft" ADD CONSTRAINT "content_draft_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- Also the pair, for the same reason: a draft cannot be filed under another
-- organization's project.
ALTER TABLE "content_draft" ADD CONSTRAINT "content_draft_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "content_project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_draft" ADD CONSTRAINT "content_draft_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
