# `drivers/`

**Status: implemented — Phase 14.**

Driver profiles and availability.

## What's here

- `DriversService` owns `Driver`: vehicle details, shift status (`isOnline`),
  operational availability (`isAvailable`) and live location.
- `DriversController` (`/drivers`) — staff CRUD, gated by `drivers:read` /
  `drivers:write`. Not branch-scoped: a driver belongs to the organisation, not
  a fixed branch, since deliveries are assigned per job.
- `DriverSelfController` (`/driver/me`) — the driver app's own-profile surface,
  gated by `deliveries:own` (the only permission the DRIVER role holds). Every
  method resolves the profile by the caller's own user id, never by a supplied
  driver id.

## Rules this module upholds

- A driver profile can only be created for a user that already holds the
  DRIVER role (provisioned via `npm run staff:create`) — `users/` has no admin
  API yet, so role assignment stays a script for now.
- `isOnline` is the driver's own shift switch. Going offline always clears
  `isAvailable`. Going online sets it, unless the driver already holds an
  active delivery.
- **`isAvailable` means "carrying nothing", and it does not gate assignment.**
  A busy driver may be given another drop — see `assertCanTakeAnotherJob` — up
  to `DRIVER_MAX_ACTIVE_DELIVERIES`. That ceiling is a **safety limit, not a
  business rule about batching**: how many drops one driver should carry
  depends on the vehicle, the bag and the distances, which is the owner's
  answer. Confirm it before launch.
- **`isAvailable: false` covers two different situations and only one of them
  is assignable.** *Carrying work* is; *stepped away* (`setAvailability` — a
  break, only possible while holding nothing) is not. What separates them is
  the **active-delivery count**, which is why the assignment guard reads the
  count rather than the flag. Reading the flag alone would have made the break
  switch a control that controls nothing, which is worse than not having one.
- A driver may step away temporarily while online (`setAvailability`), but
  never while a delivery is in progress — availability is system-controlled
  for as long as a driver holds work (see `delivery/`, which holds it down on
  assignment and releases it when the **last** job closes out, whichever way it
  ends).
- **The ceiling is enforced by a row lock, not by a read.**
  `assertCanTakeAnotherJob` takes `SELECT ... FOR UPDATE` on the driver before
  counting. The previous guard was a conditional `isAvailable: true → false`
  update, which the database serialised for free; making busy drivers
  assignable removed that, and without the lock concurrent dispatchers each
  read the same count, each pass, and all of them land.
  `test/integration/concurrency.spec.ts` fails without it.
- **Coordinates leave this module as numbers.** `currentLatitude` and
  `currentLongitude` are `Decimal` columns and `Prisma.Decimal` serialises to a
  JSON *string*; `serializeDriver` converts them. See `src/common/geo.ts` for
  the two screens that broke while it did not.
- A driver reaches only their own profile and location. One driver can never
  read or change another's by guessing an id.

## Known gaps — flagged, not guessed

- **No masked calling — and the owner has decided not to wait for it.** The
  spec asks for privacy-safe driver contact and no call-masking provider is
  contracted (same "blocked on business input" category as SMS and maps). The
  gap is therefore closed the blunt way rather than left open: the assigned
  driver gets the customer's **real** number for the duration of the delivery and
  no longer (`delivery/customer-contact.ts`). Masking remains the better answer if a
  provider is ever contracted, and that file is the single place to change.
- **No earnings/payout model.** The spec's "history and earnings" for the
  driver app has no data model behind the earnings half — a payout/commission
  structure needs a business decision before it can be schema'd. History
  (past deliveries) is served today; earnings is not invented here.
- **No route optimisation.** The driver app orders a stacked run
  (`driver-app/src/delivery/run.ts`: collections before drop-offs, oldest
  first) and that is a sensible default, not a shortest-path. Real sequencing
  needs a routing provider, which nobody has approved the spend for — the same
  blocked-on-business-input category as the delivery-distance API.

---

_Implemented in Phase 14. See `delivery/README.md` for the assignment and
driver-facing fulfilment leg._
