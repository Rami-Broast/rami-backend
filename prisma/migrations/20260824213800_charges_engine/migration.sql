-- CreateEnum
CREATE TYPE "ChargeType" AS ENUM ('FIXED', 'PERCENTAGE', 'PER_ITEM');

-- CreateEnum
CREATE TYPE "ChargeAppliesTo" AS ENUM ('SUBTOTAL', 'DELIVERY');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "chargesMinor" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Charge" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "type" "ChargeType" NOT NULL,
    "appliesTo" "ChargeAppliesTo" NOT NULL DEFAULT 'SUBTOTAL',
    "amountMinor" INTEGER,
    "percentBps" INTEGER,
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    "taxClass" "TaxClass" NOT NULL DEFAULT 'STANDARD',
    "branchIds" JSONB,
    "conditions" JSONB,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Charge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderCharge" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "chargeId" TEXT,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "grossMinor" INTEGER NOT NULL,
    "vatMinor" INTEGER NOT NULL,
    "totalMinor" INTEGER NOT NULL,
    "taxable" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderCharge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Charge_isActive_startsAt_endsAt_idx" ON "Charge"("isActive", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "OrderCharge_orderId_idx" ON "OrderCharge"("orderId");

-- AddForeignKey
ALTER TABLE "OrderCharge" ADD CONSTRAINT "OrderCharge_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderCharge" ADD CONSTRAINT "OrderCharge_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "Charge"("id") ON DELETE SET NULL ON UPDATE CASCADE;
