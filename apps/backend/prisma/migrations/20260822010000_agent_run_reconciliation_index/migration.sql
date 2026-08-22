-- CreateIndex
CREATE INDEX "agent_run_status_updatedAt_idx" ON "agent_run"("status", "updatedAt");
