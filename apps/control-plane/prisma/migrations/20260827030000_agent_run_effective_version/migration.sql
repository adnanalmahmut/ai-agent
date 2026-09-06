-- Pin new agent runs to the immutable organization-agent version selected at
-- acceptance. The column remains nullable so the preceding image can be rolled
-- back safely and existing runs keep their honest pre-installation history.

-- CreateIndex
CREATE UNIQUE INDEX "organization_agent_version_id_organizationId_key" ON "organization_agent_version"("id", "organizationId");

-- AlterTable
ALTER TABLE "agent_run" ADD COLUMN "organizationAgentVersionId" TEXT;

-- CreateIndex
CREATE INDEX "agent_run_organizationAgentVersionId_idx" ON "agent_run"("organizationAgentVersionId");

-- AddForeignKey
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_organizationAgentVersionId_organizationId_fkey" FOREIGN KEY ("organizationAgentVersionId", "organizationId") REFERENCES "organization_agent_version"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
