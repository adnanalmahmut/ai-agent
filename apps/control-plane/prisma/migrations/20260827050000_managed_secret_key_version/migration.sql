-- Expand-only rollout: the preceding image neither reads nor writes this
-- column, so existing rows and rollback-window writes remain null. The new
-- image records a non-null version on every new encryption and treats null as
-- the explicit pre-version compatibility shape.
ALTER TABLE "managed_secret"
ADD COLUMN "keyVersion" TEXT;
