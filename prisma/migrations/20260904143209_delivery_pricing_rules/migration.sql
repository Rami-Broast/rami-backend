-- AlterTable
ALTER TABLE "BranchSetting" ADD COLUMN     "deliveryBaseFeeCoversKm" DECIMAL(6,2) NOT NULL DEFAULT 5,
ADD COLUMN     "deliveryPerKmFeeMinor" INTEGER NOT NULL DEFAULT 300,
ADD COLUMN     "deliveryRoadFactor" DECIMAL(4,2) NOT NULL DEFAULT 1.3,
ADD COLUMN     "deliveryUpliftPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
ALTER COLUMN "deliveryRadiusKm" DROP NOT NULL,
ALTER COLUMN "deliveryRadiusKm" DROP DEFAULT,
ALTER COLUMN "deliveryFeeMinor" SET DEFAULT 500,
ALTER COLUMN "minOrderMinor" SET DEFAULT 4000;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "deliveryUpliftPercent" DECIMAL(5,2);

-- Backfill branches that already exist.
--
-- A column default applies to new rows only, so without this every existing
-- branch would keep deliveryFeeMinor = 0 and minOrderMinor = 0 and the owner's
-- confirmed numbers would apply to nothing. Guarded on the old defaults so a
-- branch that has already been given real values is left alone.
UPDATE "BranchSetting"
SET "deliveryFeeMinor" = 500
WHERE "deliveryFeeMinor" = 0;

UPDATE "BranchSetting"
SET "minOrderMinor" = 4000
WHERE "minOrderMinor" = 0;

-- deliveryRadiusKm was never read by any query before this migration — it was
-- a stored value nothing enforced. This migration starts enforcing it, so
-- leaving the old default of 10 in place would newly refuse every delivery
-- beyond 10 km on branches whose owner never chose that limit. Clearing it to
-- NULL (no limit) preserves the behaviour customers have today; the owner sets
-- a real radius per branch from the admin panel.
UPDATE "BranchSetting"
SET "deliveryRadiusKm" = NULL
WHERE "deliveryRadiusKm" = 10;
