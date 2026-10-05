-- Per-branch printer config (see kitchen-pos).
--
-- Free-text slugs rather than enums, because the adapter list grows per
-- physical branch as new printer models arrive; an enum here would force a
-- schema migration for every new supported printer. The backend never talks
-- to the printer directly (spec §15, §31) — this is a hint for kitchen-pos
-- to pick the right driver at boot.

ALTER TABLE "BranchSetting"
  ADD COLUMN "printerModel" TEXT,
  ADD COLUMN "printerConnection" TEXT;
