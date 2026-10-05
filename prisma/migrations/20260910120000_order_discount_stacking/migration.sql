-- A promotion and a coupon may now apply to the same order, so "which discount
-- paid" stops being answerable from Order.couponId / Order.promotionId alone:
-- both can be set, and Order.discountMinor is their sum. OrderDiscount records
-- each one as it was actually given, after the pricing engine's clamp.

CREATE TYPE "DiscountKind" AS ENUM ('COUPON', 'PROMOTION');

CREATE TABLE "OrderDiscount" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" "DiscountKind" NOT NULL,
    "couponId" TEXT,
    "promotionId" TEXT,
    "label" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "appliesToDeliveryFee" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderDiscount_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrderDiscount_orderId_idx" ON "OrderDiscount"("orderId");
CREATE INDEX "OrderDiscount_couponId_idx" ON "OrderDiscount"("couponId");
CREATE INDEX "OrderDiscount_promotionId_idx" ON "OrderDiscount"("promotionId");

-- Cascade with the order it belongs to; SetNull from the offer, like every
-- other snapshot — deleting a promotion must never rewrite an order it paid on.
ALTER TABLE "OrderDiscount" ADD CONSTRAINT "OrderDiscount_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderDiscount" ADD CONSTRAINT "OrderDiscount_couponId_fkey"
    FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OrderDiscount" ADD CONSTRAINT "OrderDiscount_promotionId_fkey"
    FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: every existing order carried at most one discount, and which one
-- it was is exactly what couponId / promotionId already say.
INSERT INTO "OrderDiscount" ("id", "orderId", "kind", "promotionId", "label", "amountMinor")
SELECT gen_random_uuid()::text, o."id", 'PROMOTION', o."promotionId", COALESCE(p."name", 'Promotion'), o."discountMinor"
FROM "Order" o JOIN "Promotion" p ON p."id" = o."promotionId"
WHERE o."promotionId" IS NOT NULL AND o."discountMinor" > 0;

INSERT INTO "OrderDiscount" ("id", "orderId", "kind", "couponId", "label", "amountMinor")
SELECT gen_random_uuid()::text, o."id", 'COUPON', o."couponId", COALESCE(c."code", 'Coupon'), o."discountMinor"
FROM "Order" o JOIN "Coupon" c ON c."id" = o."couponId"
WHERE o."couponId" IS NOT NULL AND o."promotionId" IS NULL AND o."discountMinor" > 0;
