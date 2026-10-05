-- Customer-raised refund and cancellation requests.
--
-- A customer could cancel an order themselves only while it sat in
-- PENDING_PAYMENT / AWAITING_ACCEPTANCE / CONFIRMED. After that the API said
-- "Please contact the branch" and the platform held nothing: no request, no
-- queue, no record that anyone had asked. Whether a refund happened depended on
-- someone remembering a phone call, and the customer had no way to see what had
-- been decided.
--
-- `RefundRequest` is the ask. `Refund` stays the money. They are two tables
-- because a refused request still has to exist, and a `Refund` row for money
-- nobody moved would be a lie about the money.

CREATE TYPE "RefundRequestType" AS ENUM ('CANCELLATION', 'REFUND');
CREATE TYPE "RefundRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

CREATE TABLE "RefundRequest" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "type" "RefundRequestType" NOT NULL,
    "status" "RefundRequestStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT NOT NULL,
    "resolutionNote" TEXT,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "refundId" TEXT,
    "orderCancelled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefundRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RefundRequest_refundId_key" ON "RefundRequest"("refundId");
CREATE INDEX "RefundRequest_branchId_status_idx" ON "RefundRequest"("branchId", "status");
CREATE INDEX "RefundRequest_orderId_idx" ON "RefundRequest"("orderId");
CREATE INDEX "RefundRequest_customerId_createdAt_idx" ON "RefundRequest"("customerId", "createdAt");
CREATE INDEX "RefundRequest_status_createdAt_idx" ON "RefundRequest"("status", "createdAt");
CREATE INDEX "RefundRequest_reviewedByUserId_idx" ON "RefundRequest"("reviewedByUserId");

-- One *open* request per order, enforced by the database.
--
-- An application-level "does this order already have a pending request?" check
-- is not a guarantee: two taps of a Submit button on a slow connection both pass
-- it and both insert, and the branch then works the same complaint twice and can
-- approve it twice. Prisma cannot express a partial unique index, so it is
-- declared here; the service catches the resulting P2002 and returns the request
-- that won.
CREATE UNIQUE INDEX "RefundRequest_orderId_open_key"
    ON "RefundRequest"("orderId")
    WHERE "status" = 'PENDING';

ALTER TABLE "RefundRequest"
    ADD CONSTRAINT "RefundRequest_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RefundRequest"
    ADD CONSTRAINT "RefundRequest_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RefundRequest"
    ADD CONSTRAINT "RefundRequest_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "Branch"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RefundRequest"
    ADD CONSTRAINT "RefundRequest_reviewedByUserId_fkey"
    FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "RefundRequest"
    ADD CONSTRAINT "RefundRequest_refundId_fkey"
    FOREIGN KEY ("refundId") REFERENCES "Refund"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
