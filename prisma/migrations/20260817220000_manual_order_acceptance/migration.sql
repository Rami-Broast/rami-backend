-- Adds the AWAITING_ACCEPTANCE order status and the per-branch
-- `autoAcceptOrders` toggle that decides which side of it a new order lands on.
--
-- The enum ALTER runs first (Postgres requires new enum values to exist before
-- any statement that references them, and outside a transaction — Prisma
-- handles the split automatically).

ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'AWAITING_ACCEPTANCE';

ALTER TABLE "BranchSetting"
  ADD COLUMN "autoAcceptOrders" BOOLEAN NOT NULL DEFAULT true;
