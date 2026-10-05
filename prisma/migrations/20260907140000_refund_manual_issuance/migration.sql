-- The branch decides; the owner pays out by hand.
--
-- Owner decision: a branch manager approves or declines a customer's refund
-- request, and the owner then issues the money in the payment gateway's own
-- dashboard and records it here. Approving therefore no longer calls the
-- gateway, which means the platform has to hold two facts it previously did
-- not: how much was agreed, and whether it has actually been paid.
--
-- Without both, an approved request is a promise nobody can audit — the queue
-- says "approved" and no screen can answer "did the customer get their money".

-- What the branch agreed to give back. Recorded at the decision, because the
-- decision and the payout are two acts by two different people.
ALTER TABLE "RefundRequest" ADD COLUMN "approvedAmountMinor" INTEGER;

-- When the owner recorded that the money went back. NULL on an APPROVED request
-- means money is still owed.
ALTER TABLE "RefundRequest" ADD COLUMN "refundIssuedAt" TIMESTAMP(3);

-- Finding the payout queue — approved, money still owed — is the owner's daily
-- read, so it gets an index rather than a scan of every request ever made.
CREATE INDEX "RefundRequest_status_refundIssuedAt_idx"
    ON "RefundRequest"("status", "refundIssuedAt");

-- A refund a person issued in the gateway dashboard and recorded here, rather
-- than one the platform requested through the gateway API.
--
-- The distinction has to survive in the data: a manually recorded refund has no
-- `gatewayRefundId`, so no webhook will ever confirm it, and anything reasoning
-- about refunds in flight must not sit waiting for one. `gatewayReference`
-- carries what the person pasted from the dashboard, which is what ties this
-- row to its line on the gateway's payout at reconciliation.
ALTER TABLE "Refund" ADD COLUMN "issuedManually" BOOLEAN NOT NULL DEFAULT false;
