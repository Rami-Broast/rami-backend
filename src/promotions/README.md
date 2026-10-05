# Promotions

An **automatic discount**: the owner publishes an offer, and a qualifying cart
gets it at checkout with nobody typing anything.

That is the whole difference from a coupon, and it is why this module exists
alongside `../coupons` rather than inside it. A coupon is *claimed* — by one
customer, against usage limits, per-customer caps and eligibility rules. A
promotion is a standing price the branch is offering everybody who walks in.

## What was here before, and why it was the worst state to be in

A promotion could be created, published, listed, soft-deleted and served to the
customer app through `/customer/config` — and **nothing applied it to a price**.
The endpoints all worked, the permissions were seeded, the data model was
complete, and a promotion discounted exactly nothing.

That is worse than not having the feature. An owner publishing "20% off burgers"
had every signal that it worked and no signal that it did not; the only way to
find out was a customer paying full price for something the app said was on
offer.

## The shape, which mirrors coupons deliberately

```
PromotionsService.evaluateForCart   → DB facts
  selectBestPromotion               → pure, tested, decides
    → ResolvedDiscount              → VatService
```

`promotion-evaluation.ts` is pure: no database, no framework. It is handed
promotions, the cart's lines and the branch, and it returns a `ResolvedDiscount`
— the same currency the coupon module speaks. **A promotion never touches tax
arithmetic**; `VatService` remains the only place a payable amount is decided.

The cart lines it is measured against come from the pricing engine's *own*
priced lines (`OrdersService.promotionLines`), not from a second implementation
of "what is this line worth". The day those two disagreed, the discount would be
right on one screen and wrong on the bill.

## Four rules that decide money

**1. A promotion listing products is measured on those products only.** "20% off
burgers" must not take 20% off the drinks in the same basket. A promotion
listing no products is basket-wide.

**2. Only one promotion applies, and it is the one worth most.** Two automatic
discounts compounding is how an order reaches a price nobody published, and it
is invisible until the settlement report. `priority` breaks a tie and nothing
more — it has only ever meant display ordering, and promoting it to the field
that decides money would change what every existing row means.

**3. A promotion and a coupon stack** (owner decision, 2026-09-10). Both are
evaluated and both are applied. They did not until then: `resolveDiscount` took
whichever was worth more and reported the loss in `couponSuperseded`.

Two things hold the giveaway in: the engine **clamps** each bucket to what it
applies to, so however generous a pair is an order reaches zero and never a
negative total; and **nothing compounds** — each amount was resolved against the
undiscounted gross, so two 20% offers take 40% off rather than 36%. Whether that
is the intended generosity is an owner question, and `resolveDiscount` is where
it is answered.

**4. What each discount gave is recorded** (`OrderDiscount`). `discountMinor` is
the total; these rows are which offer took it off, which `couponId` /
`promotionId` can no longer say now that both may be set. The amounts are the
ones **given, after the clamp** — recording what the discounts asked for would
book a giveaway that never happened, and the rows would not sum to
`discountMinor`.

`couponSuperseded` therefore has nothing to report and is always null. It stays
on the response because clients render it; a field that quietly changes meaning
is worse than one that goes quiet.

Rule 2 is still a **conservative default, not an owner decision**: two
*promotions* do not stack with each other, and the largest wins. Extending
stacking to those is a different question from this one, because a promotion is
a price the branch published to everybody and nothing caps how many of them can
overlap.

## Where it is applied

| Path | Why |
| --- | --- |
| `OrdersService.quoteForCustomer` | The customer app's checkout total. Evaluated on every quote, code or no code. |
| `OrdersService.placeOrder` | What the customer is actually charged. |
| `OrdersService.placeOrderForStaff` | Counter orders get the same offer as online ones. |
| `CatalogController.quote` (`POST /pricing/quote`) | The Branch POS's running total. Without it the counter reads out one price and the till takes another. |

`Order.promotionId` records which promotion paid, beside `Order.couponId`. Only
one of the two is ever set, but keeping them separate is what lets a report
answer "how much of last month's discount did our own promotions give away" —
which a single merged column cannot.

## Not built, deliberately

- **No usage limits.** `Promotion` has no `totalUsageLimit`/`usageCount`, so
  there is no redemption ledger and nothing to make atomic. A promotion is
  bounded by its dates, not by a count. Adding a cap means adding both columns
  and the same conditional-increment discipline `CouponUsage` uses — an
  application-level check would not hold under concurrent checkouts.
- **No per-customer targeting.** That is what a coupon is for.
- **No "buy one get one" or tiered logic.** The discount types are the three the
  schema carries. A new shape is a new `DiscountType`, a new branch in
  `amountFor`, and its own tests.
