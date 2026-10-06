-- Record which automatic promotion paid for an order's discount.
--
-- Promotions could already be created, published and served to the customer
-- app, and nothing applied them to a price — so the feature looked finished and
-- discounted nothing. Applying them needs somewhere to record which promotion
-- did it: `Order.discountMinor` alone cannot say whether a discount came from a
-- coupon the customer typed or an offer the branch was running, and that is the
-- first question asked when the month's discount total is queried.
--
-- Nullable and SET NULL on delete, exactly like `couponId`: a deleted promotion
-- must not take the orders it discounted with it, and the amount charged is
-- already snapshotted on the order regardless.
ALTER TABLE "Order" ADD COLUMN "promotionId" TEXT;

CREATE INDEX "Order_promotionId_idx" ON "Order"("promotionId");

ALTER TABLE "Order"
    ADD CONSTRAINT "Order_promotionId_fkey"
    FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
