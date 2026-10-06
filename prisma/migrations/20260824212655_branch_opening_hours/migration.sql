-- CreateTable
CREATE TABLE "BranchOpeningHours" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "dayOfWeek" SMALLINT NOT NULL,
    "openMinute" SMALLINT NOT NULL,
    "closeMinute" SMALLINT NOT NULL,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BranchOpeningHours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchHoursOverride" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "openMinute" SMALLINT,
    "closeMinute" SMALLINT,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BranchHoursOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BranchOpeningHours_branchId_idx" ON "BranchOpeningHours"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "BranchOpeningHours_branchId_dayOfWeek_openMinute_key" ON "BranchOpeningHours"("branchId", "dayOfWeek", "openMinute");

-- CreateIndex
CREATE INDEX "BranchHoursOverride_branchId_idx" ON "BranchHoursOverride"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "BranchHoursOverride_branchId_date_key" ON "BranchHoursOverride"("branchId", "date");

-- AddForeignKey
ALTER TABLE "BranchOpeningHours" ADD CONSTRAINT "BranchOpeningHours_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchHoursOverride" ADD CONSTRAINT "BranchHoursOverride_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
