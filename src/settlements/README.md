# `settlements/`

**Status: implemented — Phase 18.**

Settlement and reconciliation.

## What's here

- `settlement-reconciliation.ts` — a pure, exhaustively unit-tested function
  that matches a gateway payout report against our own records and classifies
  every line. No database, no framework.
- `SettlementsService` — feeds the reconciler database facts, persists the
  `Settlement`, its `SettlementTransaction` lines and a `GatewayFee` per
  fee-bearing line, and sets the settlement's status.
- `SettlementsController` (`/settlements`) — `POST` to ingest and reconcile a
  payout (`settlements:write`, owner-level); `GET` list/detail
  (`settlements:read`).

## The rule that shapes the module

**Settlement is never derived from order totals.** Expected net is
reconstructed from the money-movement records — captured `Payment`s, completed
`Refund`s and their recorded gateway fees — and compared against what the
payout claims it paid out. An order's `totalMinor` is never read here: a
discount that never reached the gateway, or a fee the gateway took, would both
be invisible if it were.

```
expected net = Σ captured payments − Σ gateway fees − Σ completed refunds   (our records)
actual net   = Σ payout line nets                                            (the payout)
variance     = actual − expected
```

## How a payout line is classified

Each line is matched by its gateway reference against our records:

| Outcome | Meaning |
| --- | --- |
| `MATCHED` | A record exists and its amount and fee agree. |
| `UNEXPECTED` | A record exists but the amount or fee disagrees. |
| `DUPLICATE` | A second payout line for a record an earlier line already covered. |
| `UNMATCHED` | The payout references something we have no record of. |
| `MISSING` | One of our captured payments / completed refunds that no payout line covered. |

A settlement is `MATCHED` only when every line matched **and** the variance is
zero; otherwise it is `DISCREPANCY`, for a human to review before sign-off.

## Properties worth knowing

- **Idempotent** per `(gatewayName, settlementReference)` — a re-submitted
  payout is rejected, and a concurrent double-ingest loses on the unique
  constraint, never double-counts.
- **Branch-isolated.** An organisation-wide settlement (no branch) is
  owner-only; a branch-scoped one is reachable only by staff assigned to that
  branch. Recording a payout is `settlements:write` (owner); viewing is
  `settlements:read` (owner or the branch's staff).
- **BigInt aggregates cross the API as strings**, the same choice made for
  `Decimal`, so a value that could exceed a JS safe integer over a long period
  is never rounded and BigInt (which JSON cannot serialise) never reaches the
  encoder.

## Scope note

The payout is submitted as gateway-neutral lines (`gatewayReference`, `type`,
`amountMinor`, `feeMinor`). Wiring a specific gateway's payout-report format or
payout API into this shape is an adapter concern for when real credentials
exist — the same "never invent a gateway's API" rule that governs the Tap
adapter (see the root `CLAUDE.md`). The reconciliation itself is complete and
gateway-agnostic.

---

_Implemented in Phase 18 alongside `reports/`._
