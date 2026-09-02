-- Human approval and one idempotent external side effect.
--
-- Additive only, in both directions.
--
-- The four new "tool_execution_status" values are only ever written by this
-- image. The preceding image writes STARTED and transitions to SUCCEEDED or
-- FAILED; it never reads rows by status, so a rollback leaves side-effect rows
-- in states it does not name, unexamined rather than broken.
--
-- The four new "tool_execution" columns carry defaults or are nullable, so a
-- row written by the preceding image -- which does not know they exist -- means
-- exactly what a read-only execution means: no effect attempted.
--
-- "tool_execution_approval" is a new table the preceding image never reads.
-- Its reference to an execution is the composite ("toolExecutionId",
-- "organizationId") against the new unique on tool_execution("id",
-- "organizationId"), so PostgreSQL -- not a service predicate -- refuses an
-- approval recorded against another organization's execution.

-- CreateEnum
CREATE TYPE "tool_execution_approval_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterEnum
ALTER TYPE "tool_execution_status" ADD VALUE 'AWAITING_APPROVAL';
ALTER TYPE "tool_execution_status" ADD VALUE 'APPROVED';
ALTER TYPE "tool_execution_status" ADD VALUE 'REJECTED';
ALTER TYPE "tool_execution_status" ADD VALUE 'OUTCOME_UNKNOWN';

-- AlterTable
ALTER TABLE "tool_execution" ADD COLUMN     "effectAttemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "effectFirstAttemptedAt" TIMESTAMP(3),
ADD COLUMN     "effectPayloadDigest" TEXT,
ADD COLUMN     "providerMessageId" TEXT;

-- CreateTable
CREATE TABLE "tool_execution_approval" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "toolExecutionId" TEXT NOT NULL,
    "status" "tool_execution_approval_status" NOT NULL DEFAULT 'PENDING',
    "inputDigest" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" TEXT,
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tool_execution_approval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tool_execution_approval_toolExecutionId_key" ON "tool_execution_approval"("toolExecutionId");

-- CreateIndex
CREATE INDEX "tool_execution_approval_organizationId_status_requestedAt_i_idx" ON "tool_execution_approval"("organizationId", "status", "requestedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tool_execution_approval_toolExecutionId_organizationId_key" ON "tool_execution_approval"("toolExecutionId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "tool_execution_id_organizationId_key" ON "tool_execution"("id", "organizationId");

-- AddForeignKey
ALTER TABLE "tool_execution_approval" ADD CONSTRAINT "tool_execution_approval_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_execution_approval" ADD CONSTRAINT "tool_execution_approval_toolExecutionId_organizationId_fkey" FOREIGN KEY ("toolExecutionId", "organizationId") REFERENCES "tool_execution"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
