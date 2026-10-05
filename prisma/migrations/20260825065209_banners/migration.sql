-- CreateEnum
CREATE TYPE "BannerAction" AS ENUM ('NONE', 'PRODUCT', 'CATEGORY', 'BRANCH', 'EXTERNAL_URL', 'OFFERS');

-- CreateTable
CREATE TABLE "Banner" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "imageUrlAr" TEXT,
    "title" TEXT NOT NULL,
    "titleAr" TEXT,
    "description" TEXT,
    "descriptionAr" TEXT,
    "buttonText" TEXT,
    "buttonTextAr" TEXT,
    "action" "BannerAction" NOT NULL DEFAULT 'NONE',
    "targetId" TEXT,
    "targetUrl" TEXT,
    "branchIds" TEXT[],
    "priority" INTEGER NOT NULL DEFAULT 0,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Banner_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Banner_isActive_priority_idx" ON "Banner"("isActive", "priority");
