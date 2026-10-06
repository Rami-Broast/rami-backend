-- Order-edit history (spec §32).
--
-- Append-only. `snapshotBefore` / `snapshotAfter` are JSON so future edit
-- shapes don't need a migration to be tracked. Every edit requires a
-- staff reason.

CREATE TYPE "OrderEditAction" AS ENUM (
  'UPDATE_ITEM_QUANTITY',
  'UPDATE_ITEM_NOTES',
  'REMOVE_ITEM',
  'ADD_ITEM',
  'UPDATE_ORDER_NOTES'
);

CREATE TABLE "OrderEdit" (
  "id"             TEXT PRIMARY KEY,
  "orderId"        TEXT NOT NULL,
  "orderItemId"    TEXT,
  "editedByUserId" TEXT NOT NULL,
  "action"         "OrderEditAction" NOT NULL,
  "reason"         TEXT NOT NULL,
  "snapshotBefore" JSONB,
  "snapshotAfter"  JSONB,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "OrderEdit_orderId_fkey"        FOREIGN KEY ("orderId")        REFERENCES "Order"("id")     ON DELETE CASCADE  ON UPDATE CASCADE,
  CONSTRAINT "OrderEdit_orderItemId_fkey"    FOREIGN KEY ("orderItemId")    REFERENCES "OrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "OrderEdit_editedByUserId_fkey" FOREIGN KEY ("editedByUserId") REFERENCES "User"("id")      ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "OrderEdit_orderId_createdAt_idx"        ON "OrderEdit"("orderId", "createdAt");
CREATE INDEX "OrderEdit_editedByUserId_createdAt_idx" ON "OrderEdit"("editedByUserId", "createdAt");
