# `coupons/`

**Status: implemented — Phase 17.**

Coupon validation and discount, integrated into order pricing.

## How it works

- **`coupon-evaluation.ts` is a pure function.** Given a coupon, its rules and a
  snapshot of the cart/customer, it decides eligibility and computes the discount
  — no database, no framework, fully unit-tested. Rules are **ANDed**: every rule
  must pass. Supported rule types: `FIRST_ORDER`, `MIN_SPEND`, `BRANCH`,
  `PRODUCT`, `CATEGORY`, `TIME_WINDOW`, `CUSTOMER_ELIGIBILITY`. Discount types:
  `PERCENTAGE` (with an optional cap), `FIXED_AMOUNT`, `FREE_DELIVERY`.
- **`CouponsService` supplies the database facts** the pure function needs (usage
  counts, first-order, the cart's categories) and returns a `ResolvedDiscount`.
- **The discount goes through the VAT engine like any other.** A coupon never
  touches tax arithmetic — the order engine prices the cart, evaluates the
  coupon against the subtotal, then re-prices with the discount. The client
  supplies only a code; it never influences the amount.

## Atomic reuse prevention

Two guards in the database, not the application:

- `CouponUsage.orderId` is unique — one order can consume a coupon once.
- The total-usage-limit check is a **conditional increment**
  (`updateMany ... where usageCount < totalUsageLimit`), so two concurrent
  checkouts cannot both claim the last use. Usage is recorded inside the
  order-creation transaction, so an exhausted coupon rolls the whole order back.

Per-customer limit is checked at evaluation; the total-limit atomic guard and the
unique orderId are the hard reuse protections.

## Endpoints

Staff (`/api/v1/coupons`, organisation-wide like the catalog):

| Method | Path | Permission |
| --- | --- | --- |
| POST | `/` | `coupons:write` — create a coupon with rules |
| GET | `/` | `coupons:read` — list |
| GET | `/:id` | `coupons:read` — one, with usage count |

Customers apply a coupon by passing `couponCode` to `POST /customer/orders`.

## Not yet here

- A customer-facing "preview this code against my cart" endpoint (the order
  response already reflects the discount).
- Per-customer limit as a hard atomic guard (currently a read-check).

## Tests

- `test/unit/coupon-evaluation.spec.ts` — every rule, discount type, cap/clamp,
  and validity check.
- `test/integration/coupons.spec.ts` — a coupon reducing an order total, usage
  recorded, total and per-customer limits, first-order, and that no discount
  appears without a coupon — against a real database.
