-- Per-branch sequential order numbers + a globally unique 12-digit reference.
--
-- Order numbers now count per branch from 1000000. Uniqueness therefore moves
-- from a global constraint to (branchId, orderNumber): two branches may both
-- have an order "1000000". The new referenceId is the globally unique public
-- handle, and it is random rather than sequential so it stays unguessable.

-- CreateTable
CREATE TABLE "BranchOrderSequence" (
    "branchId" TEXT NOT NULL,
    "nextNumber" INTEGER NOT NULL DEFAULT 1000000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BranchOrderSequence_pkey" PRIMARY KEY ("branchId")
);

-- AddForeignKey
ALTER TABLE "BranchOrderSequence" ADD CONSTRAINT "BranchOrderSequence_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: add the public reference, backfilled before it is made NOT NULL.
ALTER TABLE "Order" ADD COLUMN "referenceId" TEXT;

DO $$
DECLARE
    row_id TEXT;
    candidate TEXT;
BEGIN
    FOR row_id IN SELECT "id" FROM "Order" WHERE "referenceId" IS NULL LOOP
        LOOP
            -- 12 digits, first digit never 0, so the value is always 12 long.
            candidate := (floor(random() * 900000000000) + 100000000000)::bigint::text;
            EXIT WHEN NOT EXISTS (SELECT 1 FROM "Order" WHERE "referenceId" = candidate);
        END LOOP;
        UPDATE "Order" SET "referenceId" = candidate WHERE "id" = row_id;
    END LOOP;
END $$;

ALTER TABLE "Order" ALTER COLUMN "referenceId" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Order_referenceId_key" ON "Order"("referenceId");
CREATE INDEX "Order_referenceId_idx" ON "Order"("referenceId");

-- DropIndex: order numbers are no longer globally unique.
DROP INDEX IF EXISTS "Order_orderNumber_key";

-- Renumber existing orders per branch, oldest first, so every branch's history
-- reads as one continuous run from 1000000 and the new counter continues it.
WITH numbered AS (
    SELECT
        "id",
        999999 + row_number() OVER (PARTITION BY "branchId" ORDER BY "placedAt", "id") AS "number"
    FROM "Order"
)
UPDATE "Order" o
SET "orderNumber" = numbered."number"::text
FROM numbered
WHERE o."id" = numbered."id";

-- CreateIndex
CREATE UNIQUE INDEX "Order_branchId_orderNumber_key" ON "Order"("branchId", "orderNumber");

-- Seed each branch's counter just past its highest existing order number.
INSERT INTO "BranchOrderSequence" ("branchId", "nextNumber", "createdAt", "updatedAt")
SELECT b."id", COALESCE(MAX(o."orderNumber"::bigint), 999999)::int + 1, now(), now()
FROM "Branch" b
LEFT JOIN "Order" o ON o."branchId" = b."id"
GROUP BY b."id";
