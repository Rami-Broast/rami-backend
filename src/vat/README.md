# `vat/`

**Status: implemented in Phase 7.**

The pricing, discount and VAT engine — the single source of truth for the
payable amount.

## What is here

| Path | Purpose |
| --- | --- |
| `vat.service.ts` | The engine. `price(request)` returns a full breakdown. |
| `pricing.types.ts` | Inputs and outputs, including the resolved-line shape |

Money arithmetic lives in [`../common/money.ts`](../common/money.ts).

## Rules this module upholds

- **Clients never decide the payable amount.** The engine takes catalog data
  resolved server-side; a price in a request is not read.
- **VAT is 15%** (configurable, settled by the owner) and is **snapshotted** on
  every quote and every line, so a future rate change cannot rewrite history.
- **Prices are VAT-inclusive** — the tax is backed out, not added on.
- **Discounts reduce the taxable base** and are allocated across lines by the
  largest-remainder method so the parts sum exactly.
- **Two invariants are asserted on every quote**; the engine refuses to return a
  breakdown that does not add up:
  `taxableBase + vat === total`, and `sum(components) === total`.

## Needs accountant confirmation before production

- `PRICES_INCLUDE_VAT` — catalog prices already contain VAT.
- `DELIVERY_FEE_TAXABLE` — the delivery fee is part of the taxable supply.

## Not yet built

Coupon evaluation is Phase 17. The engine already accepts a resolved discount
and applies it correctly; what it does not do is decide whether a coupon is
allowed. That split is deliberate — a coupon rule change must not be able to
alter tax arithmetic.
