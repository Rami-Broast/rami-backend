-- CreateEnum
CREATE TYPE "BranchStatus" AS ENUM ('ACTIVE', 'TEMPORARILY_CLOSED', 'SUSPENDED', 'ARCHIVED');

-- AlterTable
ALTER TABLE "Branch" ADD COLUMN     "status" "BranchStatus" NOT NULL DEFAULT 'ACTIVE';

-- Backfill: inactive branches default to TEMPORARILY_CLOSED
UPDATE "Branch" SET "status" = 'TEMPORARILY_CLOSED' WHERE "isActive" = false AND "deletedAt" IS NULL;
UPDATE "Branch" SET "status" = 'ARCHIVED' WHERE "deletedAt" IS NOT NULL;

-- CreateIndex
CREATE INDEX "Branch_status_idx" ON "Branch"("status");
