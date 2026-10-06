# `customers/`

Customer accounts and addresses — the customer app's own-account surface, plus a
separate staff read view over the same table.

Two services on purpose. `CustomersService` is **self-service**: every method
scopes to `actor.id`, so one customer can never reach another's data, and a
missing id and someone else's id return the same not-found so ids cannot be
probed. `CustomerDirectoryService` is the **staff** read view, gated by
`customers:read` and branch-scoped for BRANCH_ADMIN. A bug in one must never
silently apply to the other; a staff read is not a self-read.

## Account deletion is anonymisation

`DELETE /customer/me` (`CustomersService.deleteAccount`).

Apple requires an app that supports account creation to let the customer delete
their account **from inside the app** (App Store Review Guideline 5.1.1(v)), and
it is checked in review. This endpoint is what the customer app's Delete screen
calls.

**It does not remove the row, and it must not.** `Order.customerId` is
`onDelete: Restrict`, as are `CouponUsage` and `LoyaltyTransaction`. A customer
who has ordered cannot be row-deleted, and should not be: those orders are the
restaurant's sales and VAT records, which it is legally required to retain, and
every figure in `src/reports/` is built from them. A deletion that removed them
would quietly change last month's revenue.

So what is erased is the personal data:

| | |
| --- | --- |
| `fullName`, `email` | cleared |
| `phone` | replaced with `deleted:<customerId>` |
| every `CustomerAddress` | text and coordinates blanked, then soft-deleted |
| `isActive`, `deletedAt` | `false` / now |
| refresh-token families | all revoked |
| outstanding `OtpChallenge` for the phone | invalidated |
| **`Order` and its snapshots** | **untouched** |

Three details that are load-bearing:

- **The phone number is released.** It is `@unique`, so leaving the real value
  on a dead row would mean that person could never sign up again — deleting an
  account must not be a permanent ban. The placeholder is deliberately not in
  E.164 form: nothing a keypad produces can collide with it, and no staff screen
  can dial it by mistake.
- **`ActorService` already filters `deletedAt: null`**, so a deleted customer
  cannot authenticate even while holding an unexpired access token. Revoking the
  refresh families is what ends the *other* devices.
- **The delivery address a driver actually used is safe.** It is snapshotted
  onto `Delivery` when the order reaches READY (Phase 14), so scrubbing
  `CustomerAddress` never rewrites what an order was delivered to.

### What is deliberately not built

- **Purging the anonymised row.** How long the shell record and the order rows
  are kept is a **retention decision against Saudi tax-record rules**, and it
  belongs to the restaurant's accountant. It is not guessed here, and there is
  no config knob for it either — an unused setting that nothing enforces reads
  as a feature and is not one. Whatever is decided must also match what the
  published privacy notice says.
- **An audit row.** Nothing in this codebase writes `AuditLog` yet, and
  introducing the first writer inside this change would be inventing a
  convention (action naming, what goes in `before`/`after`, how the correlation
  id is threaded) as a side effect. Worth doing deliberately — and note that
  whatever it records must not re-store the personal data this endpoint just
  erased.
- **A grace period / undo.** The deletion is immediate. If the restaurant wants
  a "you have 30 days to change your mind" window, that is a product decision
  and a scheduled job, not a change to this method.

`Notification` rows are left in place: they are the messages sent about orders,
and they belong to the order record rather than to the profile.
