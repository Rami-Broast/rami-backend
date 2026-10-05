-- Offers: a coupon the owner chooses to show in the customer app.
--
-- The app's Offers page was hard-coded marketing copy with invented codes, so
-- every code a customer tapped was rejected at checkout. An offer is now the
-- coupon itself — the same code, the same rules, the same discount the pricing
-- engine already applies — plus the artwork the owner wants on its card.
--
-- isPublic defaults to false: a coupon is as often private or single-customer
-- as it is a promotion, and publishing one by accident hands its code to
-- everybody. Every existing coupon therefore stays unlisted until an owner
-- opts it in.
ALTER TABLE "Coupon"
  ADD COLUMN "isPublic" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "imageUrl" TEXT;

CREATE INDEX "Coupon_isPublic_isActive_validUntil_idx"
  ON "Coupon" ("isPublic", "isActive", "validUntil");
