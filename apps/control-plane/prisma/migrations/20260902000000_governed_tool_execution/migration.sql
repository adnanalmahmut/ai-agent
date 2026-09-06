-- Governed tool execution: the organization's selected tool grants, and the
-- durable record of what a run actually did with them.
--
-- Additive only, in both directions.
--
-- "toolGrants" carries a default, so a row written by the preceding image --
-- which does not know the column exists -- means exactly what an empty grant
-- list means: no tools. A rollback therefore keeps every historical version
-- readable and keeps writing correct ones.
--
-- "tool_execution" is a new table the preceding image never reads, so a
-- rollback leaves its history intact and unexamined rather than broken. Its
-- reference to a run is the composite ("agentRunId", "organizationId") against
-- the existing unique on agent_run("id", "organizationId"), so PostgreSQL --
-- not a service predicate -- refuses an execution recorded against another
-- organization's run.

-- CreateEnum
CREATE TYPE "tool_execution_status" AS ENUM ('STARTED', 'SUCCEEDED', 'FAILED');

-- AlterTable
ALTER TABLE "organization_agent_version" ADD COLUMN     "toolGrants" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "tool_execution" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "agentRunId" TEXT NOT NULL,
    "agentRunAttempt" INTEGER NOT NULL,
    "toolId" TEXT NOT NULL,
    "toolVersion" INTEGER NOT NULL,
    "status" "tool_execution_status" NOT NULL DEFAULT 'STARTED',
    "input" JSONB NOT NULL,
    "output" JSONB,
    "failureCode" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tool_execution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tool_execution_organizationId_agentRunId_startedAt_idx" ON "tool_execution"("organizationId", "agentRunId", "startedAt");

-- CreateIndex
CREATE INDEX "tool_execution_organizationId_startedAt_id_idx" ON "tool_execution"("organizationId", "startedAt", "id");

-- AddForeignKey
ALTER TABLE "tool_execution" ADD CONSTRAINT "tool_execution_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_execution" ADD CONSTRAINT "tool_execution_agentRunId_organizationId_fkey" FOREIGN KEY ("agentRunId", "organizationId") REFERENCES "agent_run"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

