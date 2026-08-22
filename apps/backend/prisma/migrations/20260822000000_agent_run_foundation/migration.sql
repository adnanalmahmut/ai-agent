-- CreateEnum
CREATE TYPE "agent_run_status" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "agent_run" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "agentVersion" INTEGER NOT NULL,
    "runtime" TEXT NOT NULL,
    "status" "agent_run_status" NOT NULL DEFAULT 'QUEUED',
    "organizationId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "lastError" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_run_organizationId_idempotencyKey_key" ON "agent_run"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "agent_run_createdByUserId_idx" ON "agent_run"("createdByUserId");

-- AddForeignKey
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
