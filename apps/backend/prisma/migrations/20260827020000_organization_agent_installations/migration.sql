-- Organization-owned agent installations and immutable effective versions.
--
-- Additive only. The current application ignores both tables, so rolling back
-- leaves durable installation history intact without breaking the old image.
-- Actor attribution deliberately has no user foreign key: history must not
-- block or lose its actor during a future user lifecycle change.

-- CreateTable
CREATE TABLE "organization_agent_installation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "activeVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_agent_installation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_agent_version" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "definitionVersion" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "configuration" JSONB NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_agent_version_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organization_agent_installation_organizationId_agentId_key" ON "organization_agent_installation"("organizationId", "agentId");

-- CreateIndex
CREATE UNIQUE INDEX "organization_agent_installation_id_organizationId_key" ON "organization_agent_installation"("id", "organizationId");

-- CreateIndex
CREATE INDEX "organization_agent_installation_organizationId_idx" ON "organization_agent_installation"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "organization_agent_version_id_installationId_key" ON "organization_agent_version"("id", "installationId");

-- CreateIndex
ALTER TABLE "organization_agent_version"
ADD CONSTRAINT "organization_agent_version_installationId_revision_key"
UNIQUE ("installationId", "revision");

-- CreateIndex
CREATE INDEX "organization_agent_version_organizationId_idx" ON "organization_agent_version"("organizationId");

-- CreateIndex
CREATE INDEX "organization_agent_version_installationId_createdAt_id_idx" ON "organization_agent_version"("installationId", "createdAt", "id");

-- AddForeignKey
ALTER TABLE "organization_agent_installation" ADD CONSTRAINT "organization_agent_installation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_agent_version" ADD CONSTRAINT "organization_agent_version_installationId_organizationId_fkey" FOREIGN KEY ("installationId", "organizationId") REFERENCES "organization_agent_installation"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- Deferred so replacement can compare-and-swap the pointer before inserting
-- the candidate row. Only the CAS winner inserts revision N+1; commit still
-- refuses a dangling or cross-installation pointer, and any insert failure
-- rolls the pointer update back atomically.
ALTER TABLE "organization_agent_installation" ADD CONSTRAINT "organization_agent_installation_activeVersionId_id_fkey" FOREIGN KEY ("activeVersionId", "id") REFERENCES "organization_agent_version"("id", "installationId") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
