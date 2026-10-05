-- Give a driver a branch, so drivers can be branch-scoped at all.
--
-- Without this column `GET /drivers` returned every driver in the organisation
-- to any branch admin — name, email, licence number, vehicle plate and live GPS
-- coordinates included — because there was nothing to filter on. It also meant
-- any driver could be assigned to any branch's delivery.
ALTER TABLE "Driver" ADD COLUMN "branchId" TEXT;

ALTER TABLE "Driver"
  ADD CONSTRAINT "Driver_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Driver_branchId_idx" ON "Driver"("branchId");

-- Backfill from the branch the driver's user account is assigned to. A driver
-- is a staff user with the DRIVER role, and `staff:create` requires a branch
-- for that role, so existing drivers have one to inherit. Anyone left without
-- is visible to owners only, which is the safe direction.
UPDATE "Driver" d
SET "branchId" = ur."branchId"
FROM "UserRole" ur
JOIN "Role" r ON r."id" = ur."roleId"
WHERE ur."userId" = d."userId"
  AND r."name" = 'DRIVER'
  AND ur."branchId" IS NOT NULL
  AND d."branchId" IS NULL;
