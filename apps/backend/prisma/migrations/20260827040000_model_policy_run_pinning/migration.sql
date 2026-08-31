-- Pin bounded organization model choice on immutable organization-agent
-- versions and copy the effective model, policy revision, and price revision
-- to AgentRun inside acceptance. Nullable expansion keeps the preceding image
-- able to read and write during a rolling deployment or rollback; new code
-- accepts only complete pairs/triples and always writes non-null values.

-- AlterTable
ALTER TABLE "organization_agent_version"
  ADD COLUMN "modelPolicyId" TEXT,
  ADD COLUMN "modelId" TEXT;

-- AlterTable
ALTER TABLE "agent_run"
  ADD COLUMN "modelPolicyId" TEXT,
  ADD COLUMN "modelId" TEXT,
  ADD COLUMN "modelPricingRevisionId" TEXT;
