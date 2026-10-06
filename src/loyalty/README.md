# `loyalty/`

**Status: implemented — Phase 17.**

A points **ledger**. The schema deliberately holds no balance column: a balance
is `SUM(points)` over an account's append-only `LoyaltyTransaction` rows, so
there is no counter to drift from the entries that justify it.

## Earn and reverse

- **EARN** — when an order is delivered. Points = `floor(total ÷ 100) ×
  LOYALTY_POINTS_PER_SAR`. Idempotent: an order earns once.
- **REVERSE** — on cancellation (full) or refund (proportional to the refunded
  fraction). Reversal is monotonic and idempotent: a partial-then-full refund
  reverses each portion exactly once, never more than was earned. The
  specification requires refunds/cancellations to reverse points; this is how.
- **ADJUST** — a manual staff correction (`loyalty:adjust`), a new signed entry,
  attributed and audited — never an edit of history.
- REDEEM and EXPIRE entry types exist in the schema for later — redemption needs
  a business-confirmed points value (see below).

Triggers are fired **after** the triggering operation commits and are
**best-effort**: a loyalty failure is logged, never allowed to break an order or
a payment. Earn/cancel-reverse are fired by the order engine; refund-reverse by
the payments webhook handler.

## The earn rate is a business input

`LOYALTY_POINTS_PER_SAR` (default 1) is a placeholder. Like the VAT rate, the
earn rate is a business decision and must be confirmed with the owner before
launch — it is configuration, not invented in code. Set to 0 to disable earning.

## Endpoints

Customer (`/api/v1/customer/loyalty`): `GET /` — my balance and points history.

Staff (`/api/v1/loyalty`):

| Method | Path | Permission |
| --- | --- | --- |
| POST | `/adjust` | `loyalty:adjust` — manual signed adjustment |
| GET | `/:customerId` | `loyalty:read` — a customer's balance and ledger |

## Not yet here

- Redemption at checkout (REDEEM) — needs a business-confirmed points→money
  value, and tight atomic integration with order pricing. Deferred rather than
  guessing the conversion.
- Points expiry policy (EXPIRE) — needs a business-confirmed expiry window.
- Tiers and rewards catalog (`Reward`) — modelled, not yet wired.

## Tests

`test/integration/loyalty.spec.ts` — earn on delivery (once), reverse on
cancellation (idempotent), proportional reverse across a partial-then-full
refund, and a manual adjustment — against a real database.
