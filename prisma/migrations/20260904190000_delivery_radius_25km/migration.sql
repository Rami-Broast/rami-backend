-- The owner set the delivery limit at 25 km (2026-09-04).
--
-- The previous migration cleared the radius to NULL — "no limit" — because the
-- old default of 10 had never been enforced and starting to enforce it would
-- have refused deliveries no owner had chosen to refuse. The owner has now
-- named the number, so a branch starts at 25 km instead of at nothing.
ALTER TABLE "BranchSetting" ALTER COLUMN "deliveryRadiusKm" SET DEFAULT 25;

-- Apply it to the branches that already exist. Guarded to the two values that
-- mean "nobody has chosen a limit for this branch yet" — NULL (what the
-- previous migration left) and 5, which reads as the base-fee distance having
-- been typed into the radius field. A branch whose owner has set any other
-- deliberate limit keeps it.
UPDATE "BranchSetting"
SET "deliveryRadiusKm" = 25
WHERE "deliveryRadiusKm" IS NULL
   OR "deliveryRadiusKm" = 5;
