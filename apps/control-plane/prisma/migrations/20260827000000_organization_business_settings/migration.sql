-- ORG-01: typed organization locale, timezone, currency, and business profile.
--
-- Additive and rollback-compatible. Existing organizations receive complete
-- product defaults immediately, while the previous application release ignores
-- every new column. No existing Better Auth column or contract is changed.

ALTER TABLE "organization"
ADD COLUMN "locale" TEXT NOT NULL DEFAULT 'ar',
ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'UTC',
ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'USD',
ADD COLUMN "legalName" TEXT,
ADD COLUMN "industry" TEXT,
ADD COLUMN "websiteUrl" TEXT,
ADD COLUMN "businessDescription" TEXT,
ADD COLUMN "businessProfileVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "businessProfileUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
