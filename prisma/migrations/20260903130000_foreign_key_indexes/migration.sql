-- Index every foreign key that lacked one.
--
-- Postgres does not create an index for a foreign key automatically. Without
-- one, a lookup by that column is a sequential scan, and — more quietly — every
-- delete or update of the *parent* row scans the whole child table to enforce
-- the constraint. Harmless at demo volume; a lock-contention source once a
-- branch has a year of orders.
--
-- CONCURRENTLY is deliberately not used: these tables are small today and a
-- concurrent build cannot run inside the migration transaction. Revisit if this
-- is ever applied to a large production dataset.
CREATE INDEX "AuditLog_actorCustomerId_idx" ON "AuditLog"("actorCustomerId");
CREATE INDEX "CashCollection_collectedByUserId_idx" ON "CashCollection"("collectedByUserId");
CREATE INDEX "CouponUsage_customerId_idx" ON "CouponUsage"("customerId");
CREATE INDEX "DeliveryStatusHistory_changedByUserId_idx" ON "DeliveryStatusHistory"("changedByUserId");
CREATE INDEX "FeatureFlag_updatedByUserId_idx" ON "FeatureFlag"("updatedByUserId");
CREATE INDEX "LoyaltyTransaction_createdByUserId_idx" ON "LoyaltyTransaction"("createdByUserId");
CREATE INDEX "LoyaltyTransaction_refundId_idx" ON "LoyaltyTransaction"("refundId");
CREATE INDEX "LoyaltyTransaction_rewardId_idx" ON "LoyaltyTransaction"("rewardId");
CREATE INDEX "Notification_orderId_idx" ON "Notification"("orderId");
CREATE INDEX "Notification_userId_idx" ON "Notification"("userId");
CREATE INDEX "Order_couponId_idx" ON "Order"("couponId");
CREATE INDEX "Order_customerAddressId_idx" ON "Order"("customerAddressId");
CREATE INDEX "OrderCharge_chargeId_idx" ON "OrderCharge"("chargeId");
CREATE INDEX "OrderEdit_orderItemId_idx" ON "OrderEdit"("orderItemId");
CREATE INDEX "OrderItem_productVariantId_idx" ON "OrderItem"("productVariantId");
CREATE INDEX "OrderItemModifier_addonId_idx" ON "OrderItemModifier"("addonId");
CREATE INDEX "OrderStatusHistory_changedByCustomerId_idx" ON "OrderStatusHistory"("changedByCustomerId");
CREATE INDEX "OrderStatusHistory_changedByUserId_idx" ON "OrderStatusHistory"("changedByUserId");
CREATE INDEX "PaymentWebhookEvent_orderId_idx" ON "PaymentWebhookEvent"("orderId");
CREATE INDEX "PaymentWebhookEvent_paymentId_idx" ON "PaymentWebhookEvent"("paymentId");
CREATE INDEX "Refund_requestedByUserId_idx" ON "Refund"("requestedByUserId");
CREATE INDEX "Settlement_branchId_idx" ON "Settlement"("branchId");
CREATE INDEX "UserRole_roleId_idx" ON "UserRole"("roleId");
