# `reports/`

**Status: implemented — Phase 18.**

Sales, VAT and payment reporting.

## What's here

- `ReportsService` with three read-only reports over snapshotted data.
- `ReportsController` (`/reports/{sales,vat,payments}`) — all gated by
  `reports:read`, all branch-isolated, all taking an inclusive `from`/`to`
  window and an optional `branchId`.

| Report | What it answers |
| --- | --- |
| `GET /reports/sales` | Order counts by status, and snapshotted revenue (subtotal, discount, delivery fee, taxable base, VAT, total) over realised sales. |
| `GET /reports/vat` | Gross output VAT over realised sales, grouped by the VAT rate snapshotted per order. |
| `GET /reports/payments` | Captured and refunded money by payment status and by method, read from `Payment` records. |

## Rules this module upholds

- **Reports read snapshotted data.** Every order figure comes from the price
  breakdown snapshotted onto the order at purchase (Phase 8), never the live
  catalog — a menu-price change can never move a historical report. The VAT
  report groups by the rate snapshotted per order rather than assuming one, so
  a future statutory rate change shows as two groups with no past figure
  disturbed.
- **Branch isolation is the same as everywhere else.** An owner spans every
  branch; branch staff see only their assignments, whether or not they name a
  branch. Applied through `resolveRequestedBranches`.

## What "realised sales" means

The revenue and VAT figures cover orders from `CONFIRMED` onward — i.e. a
payment was taken or a cash-on-delivery order was confirmed for the kitchen —
**including** the refund states (the sale happened; a refund is a separate
money movement, reconciled in `settlements/`). Deliberately excluded:
`PENDING_PAYMENT` (never paid), `PAYMENT_FAILED` and `CANCELLED`. The sales
report also returns the full status breakdown, so the excluded orders are still
visible, just not counted as revenue.

## Known gap — flagged, not guessed

The VAT report is **gross output VAT** and does not net VAT returned by refunds
or credit notes. Netting it correctly needs per-line refund VAT and the
credit-note model, which is Phase 13 (ZATCA/invoicing) — hard-blocked on
business input (CR number, VAT registration, ZATCA phase). The response carries
an explicit `basis: "gross"` and a note so a reader never mistakes gross for
net.

---

_Implemented in Phase 18 alongside `settlements/`._
