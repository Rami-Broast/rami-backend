# `delivery/`

**Status: implemented — Phase 14.**

Delivery assignment and tracking.

## What's here

- `delivery-status.machine.ts` — a pure state machine (mirrors
  `orders/order-status.machine.ts`), unit-tested in isolation.
- `DeliveryService` owns assignment and the driver-facing leg. It does **not**
  own opening or cancelling a `Delivery` row — see below.
- `DeliveryController` (`/deliveries`) — staff reads and driver assignment,
  branch-isolated on `Delivery.branchId`, gated by `deliveries:read` /
  `deliveries:assign`.
- `DeliveryDriverController` (`/driver/deliveries`) — the driver app's
  surface, gated by `deliveries:own`. Ownership is enforced in the service: an
  unowned or unknown delivery id returns the same 404, so ids cannot be probed.

## Where a `Delivery` row comes from

`OrdersService.applyTransition` (Phase 8's single transition choke point)
opens a `Delivery` the moment a delivery order reaches `READY`, snapshotting
the customer's address the same way order placement snapshots prices — editing
or deleting the address later must not change where an in-flight order goes.
The same choke point cancels it if the order is cancelled before pickup.

This lives in `orders/`, not here, deliberately: every path that reaches
`READY` or `CANCELLED` — customer cancel, staff cancel, staff `markReady` —
must carry the cascade, and putting it at the one choke point means this
module never has to duplicate the rule or risk a caller that forgets it. The
dependency stays one-directional (`delivery` → `orders`, never the reverse),
matching how `refunds` depends on the shared payment gateway interface rather
than the other way round.

`DeliveryService` drives everything from `ASSIGNED` onward. Every
driver-initiated move — assignment, pickup, out for delivery, delivered —
advances the matching `Order.status` through `OrdersService.applyTransition`
in the same transaction, so the two records can never disagree about how far a
delivery has got.

## Stacked assignment

A driver used to be assignable only while free, so a counter could not hand a
second drop to the person already riding to that street — the food waited on
the pass until somebody came back. `assignDriver` now requires only that the
driver is **on shift**; `DriversService.assertCanTakeAnotherJob` holds the
rest, inside the assignment transaction and behind a `SELECT ... FOR UPDATE` on
the driver row, because the count is only a guard if concurrent dispatchers take
it in turn.

Two consequences worth knowing:

- **`releaseAfterDelivery` frees a driver only when it was their last job.** It
  used to set `isAvailable: true` unconditionally, which was right while a
  driver could hold exactly one delivery and is wrong now — signing for the
  first of three drops would have put them back in the counter's "free" column
  while they were still riding.
- **"Stepped away" and "busy" are different**, and both read `isAvailable:
  false`. The active-delivery count separates them; a driver on a break is not
  offered work. See `drivers/README.md`.

`driver.status` is emitted on every one of those transitions, so the counter's
picker updates while it is open rather than being a snapshot taken when the
dialog was first drawn.

## The post-pickup failure gap — flagged, not papered over

The order state machine (Phase 8) allows `CANCELLED` only up to and including
`DRIVER_ASSIGNED` — once an order is picked up, cancelling it is not a legal
move (food has left the branch), and that rule is deliberate and tested
(`order-status.machine.spec.ts`). This module does not override it.

That means a delivery that goes wrong *after* pickup — the customer is
unreachable, the address is wrong — has no order-level equivalent to fall back
on. `DeliveryService.markFailed` records `Delivery.FAILED` with a reason and
frees the driver, but **does not** touch `Order.status`. The order is left
exactly where it was for staff to resolve manually (a re-attempt, or a refund
once the fulfilment model has a real answer for this case). This is a genuine
gap in the fulfilment model as specified, not an oversight — inventing an
illegal transition or silently forcing `CANCELLED` would be worse than leaving
it as a known follow-up.

## Known gaps — flagged, not guessed

- **Calling the customer is unmasked** (owner decision), not a gap. No
  call-masking provider is contracted and the owner chose the direct number
  over withholding it — a driver at an unmarked gate with a cooling bag and
  nobody to ring was the cost of the old rule. `customer-contact.ts` holds the
  gate: the assigned driver only, and only while the delivery is live
  (`PICKED_UP`/`OUT_FOR_DELIVERY`), stripped from the payload otherwise —
  including after the drop, because past jobs stay reachable in the driver app
  and a number that outlived the delivery would accumulate into a customer
  directory on the handset. If a masking provider is ever contracted, this is the one
  place to swap.
- **`Delivery.distanceKm` is not computed.** No maps/routing provider is
  contracted (blocked on business input, spec §31); the field exists in the
  schema for when one is.
- **`ProofOfDeliveryType.OTP` is accepted as a label only.** Verifying a
  delivery code against a real challenge needs its own `OtpPurpose` and
  dispatch flow (the existing OTP infrastructure is scoped to
  `CUSTOMER_LOGIN`). `SIGNATURE` and `PHOTO` are fully supported — the client
  uploads the capture to object storage and passes back the URL; this backend
  never handles the upload itself.

---

_Implemented in Phase 14. See `drivers/README.md` for the driver profile this
module assigns._
