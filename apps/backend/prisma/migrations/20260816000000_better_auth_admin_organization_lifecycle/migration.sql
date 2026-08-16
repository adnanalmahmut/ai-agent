-- Better Auth admin + organization plugins, and this application's own
-- account/organization lifecycle state.
--
-- Every statement here is additive. There is no DROP TABLE, no DROP COLUMN,
-- and no NOT NULL added to a populated table: each new column is nullable or
-- carries a default, so existing users, sessions and accounts are untouched.
--
-- Two statements are idempotent rather than plain, and both are cleaning up
-- drift that predates migration history. The previous phase applied a
-- reviewed delta by hand, which left the `PermissionEffect` enum (referenced
-- by no column) and `session.impersonatedBy` (present, all NULL) in the
-- development database but absent from `prisma/migrations`. Guarding them
-- makes this migration correct against both that database and an empty one.

-- Orphan from the abandoned UserPermissionOverride/RBAC design. Verified to be
-- referenced by zero columns before removal; a no-op on a fresh database.
DROP TYPE IF EXISTS "PermissionEffect";

-- AlterTable: Better Auth admin plugin
ALTER TABLE "user" ADD COLUMN     "role" TEXT,
                   ADD COLUMN     "banned" BOOLEAN DEFAULT false,
                   ADD COLUMN     "banReason" TEXT,
                   ADD COLUMN     "banExpires" TIMESTAMP(3);

-- AlterTable: application account lifecycle (reversible soft delete)
ALTER TABLE "user" ADD COLUMN     "deletedAt" TIMESTAMP(3),
                   ADD COLUMN     "deletedByUserId" TEXT,
                   ADD COLUMN     "deletionReason" TEXT;

-- AlterTable: Better Auth admin + organization plugins
-- `IF NOT EXISTS` only for the drifted column; see the header note.
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "impersonatedBy" TEXT;
ALTER TABLE "session" ADD COLUMN     "activeOrganizationId" TEXT;

-- CreateTable
CREATE TABLE "organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" TEXT,
    "archivedAt" TIMESTAMP(3),
    "archivedByUserId" TEXT,
    "archiveReason" TEXT,

    CONSTRAINT "organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inviterId" TEXT NOT NULL,

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_deletedAt_idx" ON "user"("deletedAt");

-- CreateIndex
CREATE INDEX "session_activeOrganizationId_idx" ON "session"("activeOrganizationId");

-- CreateIndex
CREATE INDEX "organization_archivedAt_idx" ON "organization"("archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "organization_slug_key" ON "organization"("slug");

-- CreateIndex
CREATE INDEX "member_organizationId_idx" ON "member"("organizationId");

-- CreateIndex
CREATE INDEX "member_userId_idx" ON "member"("userId");

-- CreateIndex
CREATE INDEX "invitation_organizationId_idx" ON "invitation"("organizationId");

-- CreateIndex
CREATE INDEX "invitation_email_idx" ON "invitation"("email");

-- CreateIndex
CREATE INDEX "invitation_inviterId_idx" ON "invitation"("inviterId");

-- AddForeignKey
-- RESTRICT, not CASCADE, on all four. Users are soft-deleted and organizations
-- are archived, so a physical delete of either root is not an operation this
-- application performs. If one is ever attempted it must fail loudly rather
-- than silently shredding membership and invitation history.
ALTER TABLE "member" ADD CONSTRAINT "member_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member" ADD CONSTRAINT "member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
