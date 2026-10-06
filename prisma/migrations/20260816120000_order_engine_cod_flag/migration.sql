-- Cash on delivery is enabled per branch, never assumed. Defaults to false so
-- an existing branch does not silently begin accepting COD. See Phase 8.
ALTER TABLE "BranchSetting"
  ADD COLUMN "acceptsCashOnDelivery" BOOLEAN NOT NULL DEFAULT false;
