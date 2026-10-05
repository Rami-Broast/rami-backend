-- Record the customers a refund window turns away.
--
-- The policy's failures are otherwise invisible. An approved or declined
-- request leaves a `RefundRequest` row somebody can read; a customer told "the
-- window has closed" leaves nothing at all, because the eligibility rule
-- refuses before anything is written. So if 10 minutes turns out to be too
-- short, the platform would never say so — it would surface as phone calls to
-- branches and complaints that never reach us.
--
-- `minutesLate` is the point of the table. "How many people missed it" is a
-- number an owner can argue with; "and most of them by under five minutes" is a
-- number that answers what the window should be.

CREATE TABLE "RefundWindowMiss" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "type" "RefundRequestType" NOT NULL,
    "minutesLate" INTEGER NOT NULL,
    "windowMinutes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefundWindowMiss_pkey" PRIMARY KEY ("id")
);

-- One row per order, not per screen open.
--
-- The eligibility read runs every time a customer opens their order screen.
-- Without this constraint the table would measure how often people re-check
-- rather than how often we refuse them, and a single frustrated customer
-- refreshing would read as twenty.
CREATE UNIQUE INDEX "RefundWindowMiss_orderId_key" ON "RefundWindowMiss"("orderId");

CREATE INDEX "RefundWindowMiss_branchId_createdAt_idx" ON "RefundWindowMiss"("branchId", "createdAt");
CREATE INDEX "RefundWindowMiss_type_createdAt_idx" ON "RefundWindowMiss"("type", "createdAt");
CREATE INDEX "RefundWindowMiss_customerId_idx" ON "RefundWindowMiss"("customerId");

-- CASCADE rather than RESTRICT throughout: this is measurement, not a financial
-- record. It must never be the reason a customer's account cannot be deleted.
ALTER TABLE "RefundWindowMiss"
    ADD CONSTRAINT "RefundWindowMiss_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RefundWindowMiss"
    ADD CONSTRAINT "RefundWindowMiss_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RefundWindowMiss"
    ADD CONSTRAINT "RefundWindowMiss_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
