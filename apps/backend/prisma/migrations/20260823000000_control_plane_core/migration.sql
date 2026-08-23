-- CreateTable
CREATE TABLE "feature_flag_platform_override" (
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByUserId" TEXT,

    CONSTRAINT "feature_flag_platform_override_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "feature_flag_organization_override" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "organizationId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByUserId" TEXT,

    CONSTRAINT "feature_flag_organization_override_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runtime_setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByUserId" TEXT,

    CONSTRAINT "runtime_setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "managed_secret" (
    "key" TEXT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "algorithm" TEXT NOT NULL,
    "keyFingerprint" TEXT NOT NULL,
    "label" TEXT,
    "lastRotatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByUserId" TEXT,

    CONSTRAINT "managed_secret_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "feature_flag_platform_override_updatedByUserId_idx" ON "feature_flag_platform_override"("updatedByUserId");

-- CreateIndex
CREATE INDEX "feature_flag_organization_override_updatedByUserId_idx" ON "feature_flag_organization_override"("updatedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "feature_flag_organization_override_organizationId_key_key" ON "feature_flag_organization_override"("organizationId", "key");

-- CreateIndex
CREATE INDEX "runtime_setting_updatedByUserId_idx" ON "runtime_setting"("updatedByUserId");

-- CreateIndex
CREATE INDEX "managed_secret_updatedByUserId_idx" ON "managed_secret"("updatedByUserId");

-- AddForeignKey
ALTER TABLE "feature_flag_platform_override" ADD CONSTRAINT "feature_flag_platform_override_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_flag_organization_override" ADD CONSTRAINT "feature_flag_organization_override_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_flag_organization_override" ADD CONSTRAINT "feature_flag_organization_override_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runtime_setting" ADD CONSTRAINT "runtime_setting_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_secret" ADD CONSTRAINT "managed_secret_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
