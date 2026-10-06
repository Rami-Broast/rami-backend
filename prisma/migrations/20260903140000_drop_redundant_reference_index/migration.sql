-- `Order.referenceId` is already UNIQUE, and a unique constraint is backed by
-- an index. The extra @@index duplicated it: a second B-tree on the same column
-- that every insert and update had to maintain for no read benefit.
DROP INDEX IF EXISTS "Order_referenceId_idx";
