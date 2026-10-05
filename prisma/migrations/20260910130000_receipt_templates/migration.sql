-- The receipt template a branch prints its customer docket from: one
-- organisation default plus a partial override per branch.

CREATE TABLE "ReceiptTemplate" (
    "id" TEXT NOT NULL,
    "branchId" TEXT,
    "config" JSONB NOT NULL,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceiptTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReceiptTemplate_branchId_key" ON "ReceiptTemplate"("branchId");
CREATE INDEX "ReceiptTemplate_updatedByUserId_idx" ON "ReceiptTemplate"("updatedByUserId");

-- Postgres does not treat NULLs as equal, so the unique index above permits
-- any number of rows with a null branchId — that is, any number of
-- organisation defaults, with nothing to say which one a branch would print.
-- This is the constraint that actually holds it to one. Constraints belong in
-- the database: an application-level check is passed by two concurrent saves.
CREATE UNIQUE INDEX "ReceiptTemplate_single_default"
    ON "ReceiptTemplate" ((1)) WHERE "branchId" IS NULL;

ALTER TABLE "ReceiptTemplate" ADD CONSTRAINT "ReceiptTemplate_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReceiptTemplate" ADD CONSTRAINT "ReceiptTemplate_updatedByUserId_fkey"
    FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
