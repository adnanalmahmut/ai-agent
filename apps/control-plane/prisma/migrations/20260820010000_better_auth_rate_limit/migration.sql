CREATE TABLE "rateLimit" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "count" INTEGER NOT NULL,
  "lastRequest" BIGINT NOT NULL,
  CONSTRAINT "rateLimit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "rateLimit_key_key" ON "rateLimit"("key");
