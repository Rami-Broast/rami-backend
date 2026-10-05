-- CreateEnum
CREATE TYPE "HomepageSectionKind" AS ENUM ('BANNERS', 'CATEGORIES', 'FEATURED', 'BESTSELLERS', 'POPULAR', 'OFFERS', 'COUPONS', 'LOYALTY', 'RECOMMENDED', 'CUSTOM');

-- CreateTable
CREATE TABLE "HomepageSection" (
    "id" TEXT NOT NULL,
    "kind" "HomepageSectionKind" NOT NULL,
    "title" TEXT,
    "titleAr" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HomepageSection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HomepageSection_position_idx" ON "HomepageSection"("position");

-- CreateIndex
CREATE UNIQUE INDEX "HomepageSection_kind_key" ON "HomepageSection"("kind");
