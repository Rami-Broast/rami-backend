# `orders/`

**Status: implemented — Phase 8.**

The order engine and its fulfilment lifecycle. This is the module that turns a
customer's cart into a priced, immutable order and governs how that order moves
from placement to delivery.

## What it owns

- `Order`, `OrderItem`, `OrderItemModifier`, `OrderStatusHistory`.
- Order creation, priced server-side and snapshotted.
- The fulfilment state machine and every transition through it.

## The two load-bearing rules

1. **The client never prices anything.** A `PlaceOrderDto` carries product IDs
   and quantities — never a price or a total. `OrdersService.placeOrder` calls
   `CatalogService.resolveCartLines` (Phase 6) then `VatService` (Phase 7), and
   snapshots the result onto the order and its items. Any `price`-shaped field a
   client sends is stripped by the global validation whitelist before the DTO is
   seen, and even if it weren't, nothing here reads it. The snapshot means a
   later menu-price change can never rewrite what a customer was charged — proven
   by the `keeps the snapshot even after the menu price changes` test.

2. **Fulfilment and money are separate columns.** `Order.status` is fulfilment;
   `Order.paymentStatus` is money. Neither is derived from the other. Cash on
   delivery is the clearest demonstration: the order is `CONFIRMED` and cooked
   immediately while `paymentStatus` stays `PENDING` until the driver collects.

## The state machine

`order-status.machine.ts` is a pure module — no database, no framework — so the
transition rules are testable in isolation and live in exactly one place.

```
PENDING_PAYMENT ─▶ CONFIRMED ─▶ PREPARING ─▶ READY ─┬▶ (pickup)   DELIVERED
                                                    └▶ (delivery) DRIVER_ASSIGNED
                                                         ─▶ PICKED_UP
                                                         ─▶ OUT_FOR_DELIVERY
                                                         ─▶ DELIVERED
```

Alternative/terminal: `PAYMENT_FAILED`, `CANCELLED`, and the refund states
(`REFUND_PENDING`, `REFUNDED`, `PARTIALLY_REFUNDED`). The refund states are in
the table but are driven by the refunds module (Phase 12) — this module never
has to be edited for that.

`OrdersService.applyTransition` is the **single choke point** for a status
change: it validates the move against the machine, stamps the matching
timestamp, records a cancellation reason where relevant, and appends an
append-only `OrderStatusHistory` row attributing the change. It is exported so
later modules (payments, delivery, refunds) drive status through it rather than
mutating `status` directly.

## Branch isolation

Every staff path is isolated server-side:

- List queries use `resolveRequestedBranches(actor, branchId)` — an owner sees
  all branches (or one they name), branch staff see only their assignments.
- A route acting on one order loads it and calls `assertBranchAccess` before
  doing anything.
- Customers reach only their own orders, filtered by customer id; a missing or
  someone-else's order id returns an identical `404` so ids cannot be probed.

## Payment methods, today

- **Cash on delivery** is enabled per branch (`BranchSetting.acceptsCashOnDelivery`,
  default `false` — never assumed). A COD order is confirmed immediately and a
  pending `Payment` row (`gatewayName: "cash-on-delivery"`) records that money is
  owed; it is collected on delivery (driver flow, Phase 14).
- **Counter cash** (`CASH`) is what the Branch POS takes for a walk-in / phone
  order — see below. A `Payment` row (`gatewayName: "counter-cash"`) records it;
  its own gateway marker keeps it out of any gateway payout (settlements are
  scoped per `gatewayName`), and reports group by method so cash shows as its
  own line.
- **Online methods** (`CARD`, `MADA`, `APPLE_PAY`, `GOOGLE_PAY`) create the order
  in `PENDING_PAYMENT` with no payment row yet. Initiating the actual charge is
  **Phase 11** (Tap, behind a gateway interface with a mock adapter until real
  credentials and official docs exist). Until then an online order simply waits.

## Counter orders (Branch POS)

`OrdersService.placeOrderForStaff` (`POST /api/v1/orders`, `orders:write`) is a
branch member taking a walk-in or phone order at the counter on a customer's
behalf. It is the same engine as `placeOrder` — **priced entirely server-side,
never from the request** — with three differences:

- **Branch isolation on creation.** The order's branch is asserted against the
  caller's scope, so a branch user can only place orders for their own branch.
  Proven by the `isolates counter-order creation to the staff member's branch`
  test.
- **The customer is identified by phone, not by being the caller.** An existing
  customer is reused; a new one is created (unverified — they have not logged
  in). A phone order for delivery carries an inline address, saved as one of that
  customer's addresses so the normal delivery leg (snapshot at `READY`, driver
  assignment) works unchanged.
- **Payment is settled at the counter.** `CASH` records a paid-or-pending cash
  payment (`cashCollected` says whether the money was taken up front — a
  walk-in — or is due on collection); `CASH_ON_DELIVERY` behaves exactly like the
  customer COD path (delivery only, per-branch flag). Recording cash a staff
  member physically took is the merchant's own record of a sale, not a client
  claiming a gateway succeeded — so it is not subject to the online "success is
  never proof of payment" rule. Marking a *pending* counter-cash payment
  collected later (till reconciliation) is deferred — the same "blocked on
  business input" category as COD till reconciliation.

## Endpoints

Customer (`/api/v1/customer/orders`, authenticated customer, no permission):

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/` | Place an order |
| GET | `/` | List my orders |
| GET | `/:id` | Track one of my orders (with status history) |
| POST | `/:id/cancel` | Cancel — allowed only before preparation begins |

Staff (`/api/v1/orders`, permission-gated, branch-isolated):

| Method | Path | Permission |
| --- | --- | --- |
| POST | `/` | `orders:write` (counter order — Branch POS) |
| GET | `/` | `orders:read` |
| GET | `/:id` | `orders:read` |
| GET | `/kitchen/queue?branchId=` | `orders:kitchen` |
| POST | `/:id/preparing` | `orders:kitchen` |
| POST | `/:id/ready` | `orders:kitchen` |
| POST | `/:id/complete-pickup` | `orders:kitchen` (pickup orders only) |
| POST | `/:id/cancel` | `orders:cancel` |

Delivery-side transitions (`DRIVER_ASSIGNED` onward) are owned by the delivery
module (Phase 14); the machine already permits them.

## Not yet here

- Till reconciliation for counter cash — marking a *pending* counter-cash
  payment collected later. Deferred (business input), same category as COD till
  reconciliation.
- Invoicing on completion — Phase 13 (ZATCA), blocked on business/legal input.

## Tests

- `test/unit/order-status.machine.spec.ts` — the transition table, type
  narrowing, cancellation windows, terminal states.
- `test/unit/order-number.spec.ts` — format, UTC date, unguessable suffix.
- `test/integration/orders.spec.ts` — placement, the price snapshot, COD vs
  online, every placement guard, kitchen transitions, cancellation windows,
  branch isolation and customer isolation, and the counter-order path
  (find-or-create customer, cash paid vs pending, inline delivery address,
  manual-accept parking, branch isolation on creation), against a real database.
