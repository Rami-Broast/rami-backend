# `refunds/`

**Status: implemented — Phase 12.**

Full and partial refunds against captured gateway payments.

## The rules it enforces (spec §17)

1. **Only an authorized staff member** issues a refund — `refunds:write`, and
   only against a payment whose order is in a branch they may reach
   (`assertBranchAccess`).
2. **A refund never exceeds the remaining refundable amount** —
   `capturedAmountMinor − refundedAmountMinor` — checked at creation, and capped
   again defensively at completion so two refunds settling close together cannot
   over-refund.
3. **Every refund is idempotent** by a unique `idempotencyKey`: a retried or
   double-clicked request returns the existing refund, never a second.
4. **Completion is asynchronous.** Creating a refund puts it `PROCESSING` and the
   order into `REFUND_PENDING`; the money moves onto the payment and order only
   when a **verified gateway event** confirms it. Nothing assumes an instant
   refund.
5. **Reason, actor, timestamps, gateway reference and status** are all recorded;
   the `Refund` row is the audited record.

## What moves where

Money lives on the money columns, never on fulfilment:

- `Refund.status`: `PENDING → PROCESSING → COMPLETED | FAILED`.
- On a confirmed success: `Payment.refundedAmountMinor` increases, and
  `Payment.status` / `Order.paymentStatus` become `PARTIALLY_REFUNDED` or
  `REFUNDED` (fully refunded when the refunded total reaches captured).
- On a failed refund: the order's money state is restored (`PAID`, or
  `PARTIALLY_REFUNDED` if an earlier refund already succeeded).
- `Order.status` (fulfilment) is deliberately **not** touched by a refund — the
  two columns are independent.

## Where the pieces live

Refund logic is split by responsibility, not by circular import:

- **`RefundsService.createRefund`** — validation, the idempotent create, the
  gateway `refund()` call. Lives here.
- **`RefundsService.applyRefundEvent`** — applies a verified refund event to the
  refund/payment/order. Called by the payments module's webhook handler (which
  owns all webhook ingestion), inside its transaction. So this module depends
  only on the shared `PaymentGatewayModule` and has no dependency back on
  payments.

## Refund and cancellation **requests**

A `Refund` is money moving and only staff may start one. A `RefundRequest` is a
customer saying they want one. They are two tables, and the separation is what
makes the feature honest: a refused request still has to exist, and a `Refund`
row for money nobody moved would be a lie about the money.

Before this, a customer could cancel an order themselves only while it sat in
`PENDING_PAYMENT` / `AWAITING_ACCEPTANCE` / `CONFIRMED`. Past that the API
answered *"This order can no longer be cancelled. Please contact the branch"* and
the platform held **nothing** — no request, no queue, no record that anyone had
asked. Whether anything happened depended on somebody remembering a phone call,
and the customer had no way to see what had been decided.

### Who does what (owner decision)

Three parties, three acts, three permissions — and the split is the whole
design, not an access-control detail:

| Act | Permission | Who holds it |
| --- | --- | --- |
| Ask | — | The customer, about their own order |
| Approve / decline | `refund-requests:decide` | Owner **and branch admin** |
| Record a refund paid out | `refunds:write` | Owner only |

The **branch** decides whether a customer gets their money back. The **owner**
moves the money — by issuing the refund in the payment gateway's own dashboard
and recording it here. `refund-requests:decide` exists apart from
`refunds:write` because reusing the latter for the decision would have handed
every branch manager the direct-refund button on the Payments page too, which is
the opposite of what was asked for.

### Approving is not paying

`approve` **does not call the gateway**. It cancels the order where that is still
legal, records `approvedAmountMinor`, and returns an `outcome`:

| Outcome | Meaning |
| --- | --- |
| `AWAITING_PAYOUT` | Money is owed. The owner refunds it in the gateway dashboard and records it with `POST /:id/record-refund`. |
| `MANUAL_SETTLEMENT` | Money was taken as cash — no gateway to reverse. The branch hands it back in person. No `Refund` row. |
| `CANCELLED_NO_REFUND` | The order was stopped; nothing had been captured. |

So an **approved request with `refundIssuedAt` null is a debt**, and no screen
may call it refunded. Until `recordRefundIssued` runs, `Order.paymentStatus`
still reads `PAID` — correctly, because nothing has gone back — and the customer
is told their refund is *being arranged*, never that it has been sent.

`recordRefundIssued` is the act that writes a `COMPLETED` `Refund` marked
`issuedManually`, moves `Payment.refundedAmountMinor` / `Order.paymentStatus`,
reverses loyalty in proportion, and tells the customer. `gatewayReference` is
**required**: a refund recorded with nothing to match it against cannot be tied
to a payout line at reconciliation, and whoever could have pasted it is long gone
by the time anyone notices.

`Refund.issuedManually` is how the two kinds are told apart in the data. A
manually recorded refund has **no `gatewayRefundId`**, so no webhook will ever
confirm it — nothing may sit waiting for one. `RefundsService.createRefund` (the
gateway path, with its asynchronous webhook completion) is untouched and comes
back into use the day the real Tap adapter lands.

### The rest of the rules

- **The customer never chooses the type.** `RefundRequestType` is derived from
  the order's own status: an order still on its way is a `CANCELLATION`, one
  already with the customer is a `REFUND`. Asking a customer to classify it is
  asking them to know our fulfilment model.
- **Money is the gate on cancelling yourself, not time** (owner decision,
  2026-09-08). An **unpaid** order can be cancelled outright — nothing has been
  taken, so dropping it costs the branch nothing, and the state machine already
  refuses once the kitchen has started. A **paid** order cannot: cancelling then
  means giving money back, which is the branch's decision, so it gets the
  request path however early it is. `hasCapturedMoney`
  (`src/payments/captured-money.ts`) is the one definition both this rule and
  `OrdersService.cancelByCustomer` read, and the latter enforces it server-side
  — a client with a stale eligibility answer is still refused.
- **Two windows, two clocks, both 10 minutes** (`refund-request-eligibility.ts`,
  pure): a cancellation request runs from **placement**
  (`REFUND_CANCELLATION_WINDOW_MINUTES`) because the cost of a late change lands
  on the kitchen; a refund request runs from **delivery**
  (`REFUND_REQUEST_WINDOW_MINUTES`) because "something was wrong with what
  arrived" cannot be known until it arrives. Null on either means no deadline.
- **Both asks require a reason**, and so does a customer's own cancellation
  (`CustomerCancelOrderDto`) — staff's stays optional, because a branch already
  knows why and its reason is recorded against a named user.
- **Eligibility is served to clients** at
  `GET /customer/orders/:id/refund-eligibility`, with a customer-facing sentence
  for every outcome. No client keeps a second copy of the rule, so an app cannot
  offer a button the server then refuses.
- **One open request per order, enforced by a partial unique index**
  (`WHERE status = 'PENDING'`). The application check is passed by two taps of a
  Submit button on a slow connection; the loser of the race is handed the
  winner's request rather than an error it cannot act on. Prisma cannot express
  this, so it lives in the migration — constraints belong in the database.
- **Cancelling goes through `OrdersService.cancelByStaff`**, the order engine's
  one choke point, so the state machine, status history, delivery record and
  loyalty reversal all behave as they do for any other cancellation.
- **Approving twice, or recording a payout twice, is impossible.** The decision
  is guarded by the request's own status, and the manual refund's idempotency
  key is derived from the request id (`refund-request-manual:<id>`) rather than
  generated — the second press is the dangerous one, because the owner has
  already paid out in the dashboard by then.
- **The approved amount is capped at the decision.** The branch says the number
  out loud to the customer; discovering at payout time that it was impossible
  means telling them twice.
- **Nothing here writes `AuditLog`.** The `RefundRequest` row is its own audited
  record — who asked, why, who decided, when, what was decided, and who paid.
  This codebase still has no audit-writing convention, and setting one
  deliberately is a better idea than making a customer-facing feature its first
  writer.

## Endpoints

Staff (`/api/v1/refunds`, branch-isolated through the payment's order):

| Method | Path | Permission |
| --- | --- | --- |
| POST | `/` | `refunds:write` — issue a full/partial refund |
| GET | `/` | `refunds:read` — list |
| GET | `/:id` | `refunds:read` — one refund |

Staff request queue (`/api/v1/refund-requests`, branch-isolated on the request's
own `branchId`):

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/` | `refunds:read` — the queue (`?status=PENDING`, or `?awaitingPayout=true` for the owner's payout list) |
| GET | `/:id` | `refunds:read` |
| POST | `/:id/approve` | `refund-requests:decide` — cancel and record what is owed |
| POST | `/:id/reject` | `refund-requests:decide` — note required, sent to the customer |
| POST | `/:id/record-refund` | `refunds:write` — owner records a refund issued in the gateway dashboard |

Customer (ownership enforced by customer id; no permissions):

| Method | Path |
| --- | --- |
| GET | `/customer/orders/:id/refund-eligibility` |
| POST | `/customer/orders/:id/refund-request` |
| GET | `/customer/refund-requests` |
| POST | `/customer/refund-requests/:id/withdraw` |

Sandbox completion: `POST /webhooks/payments/mock/simulate-refund` delivers a
real signed mock refund webhook (mock gateway + sandbox only).

## Not yet here

- Credit notes tied to refunds — Phase 13 (ZATCA), blocked on legal/tax input.
- Loyalty point reversal on refund — Phase 17.
- Gateway-fee adjustment on refund in settlement — Phase 18.

## Tests

`test/integration/refunds.spec.ts` — partial then final refund, over-refund
rejection, idempotency, non-refundable payment, COD refusal, branch isolation,
and money-state restoration on a failed refund — against a real database.

`test/integration/refund-requests.spec.ts` — the lifecycle against a real
database: self-service redirect, an approval that stops the order and moves **no**
money, the owner's payout recorded afterwards (and the order only then reading as
refunded), a delivered order refunded without moving fulfilment, a
cash-on-delivery approval that writes no refund row, the one-open-request race
(two concurrent submissions, one row), a second approval and a second payout both
refused, an over-approval refused, the 10-minute window closing, and branch
isolation across the queue and every decision.

`test/unit/refund-request-eligibility.spec.ts` — the pure rule at every point of
an order's life: both windows, the clock each runs on, and the self-cancel that
is deliberately not on either.

`test/e2e/client-writes.e2e-spec.ts` — the permission split at the HTTP layer: a
branch admin decides, and is refused both `record-refund` and `POST /refunds`.
