# `audit/`

**Status: implemented (writer + read API). Coverage is a curated first tranche —
see "What is audited" — and grows deliberately, not all at once.**

Audit logging: an append-only record of who did what, when, from where, and
whether it succeeded.

## The two surfaces

- **`AuditRecorder`** (`audit-recorder.service.ts`) is the **writer** other
  modules inject. `record(entry)` inserts one `AuditLog` row. It is exported
  from `AuditModule`; a feature module imports `AuditModule` and calls it.
- **`AuditService`** (`audit.service.ts`) is the **read** API behind
  `GET /audit` — owner-only (`audit:read` is granted only to OWNER in the
  seed). Filter by actor, entity, branch, outcome, date range or correlation
  id. It never mutates.

## How the "who" and "which request" are known

Actor, correlation id, client IP and user-agent are **not** passed as arguments
through every service method. They live in a per-request
`RequestContext` (`src/common/context/`, built on Node's `AsyncLocalStorage`):

- `RequestContextMiddleware` opens the context for every request and seeds the
  correlation id (mirroring the logger's), IP and user-agent.
- The auth guard calls `setActor()` once it has resolved the actor from the
  database, so the same context now carries *who*.
- `AuditRecorder` reads all of it from the context at write time.

An action on a public route (a **staff login**) runs before the guard, so there
is no ambient actor; those callers name the actor on the entry itself
(`actorUserId`, or a full `actor`). No ambient context at all (a background job,
a test that did not wrap the call) is attributed to `SYSTEM` rather than dropped.

## Two rules that are load-bearing

1. **Best-effort, and post-commit by convention.** `record()` never throws — an
   audit write failing must not roll back or break the action it describes, the
   same rule the notification and loyalty triggers follow. Callers therefore
   record **after** their own transaction has committed, passing the before/after
   snapshots they captured. The row is written on the base client, standing on
   its own.

   **The trade this makes:** a crash in the narrow window between an action
   committing and its audit row being written leaves that action unrecorded. A
   compliance-grade guarantee would need a **transactional outbox** (write the
   audit intent inside the same transaction, deliver it after). That is
   deliberate follow-up, named here rather than pretended — the current design
   buys "the log is never the reason a refund broke" at the cost of "the log is
   not a ledger you can prove has no gaps".

2. **The caller controls the snapshot, because only the caller knows what must
   not be written.** See the account-deletion rule elsewhere: an audit row for an
   erasure must not re-store the personal data the erasure just removed. On top
   of that, `sanitizeSnapshot` (`audit-entry.ts`, pure and unit-tested) masks a
   denylist of sensitive keys (password, token, secret, card, …) at any depth,
   renders Dates as ISO strings, and serialises non-plain objects (Prisma
   `Decimal`, `BigInt`) via their own string form rather than walking their
   internals — defence in depth, the same spirit as the logger's redaction list.

## What is audited (first tranche)

The actions with no other record today, across the two categories the schema was
built for — **authentication** and **money/authorisation**. Action strings live
in `audit-actions.ts` (never inline a bare string):

- **Auth:** `staff.login`, `staff.login_failed` (the failed attempt is the one
  an incident review needs, and it leaves no other trace; the attempted email is
  stored, never a credential).
- **Staff administration:** `user.create`, `user.update`, `user.password_reset`,
  `user.role_assign`, `user.role_revoke`.
- **Branch lifecycle & settings:** `branch.create`, `branch.update`,
  `branch.status_change`, `branch.delete`, `branch.duplicate`,
  `branch.settings_update`.
- **Refunds (the money path):** `refund_request.approve`,
  `refund_request.reject`, `refund.issued` — approval and payout are separate
  rows on purpose, because they are separate acts by separate people, often
  hours apart (owner decision).

**Not yet wired** (deliberate, not forgotten): menu/price changes, coupon and
promotion changes, customer account deletion, settlement ingestion, order
status transitions (those already have `OrderStatusHistory`). Add a module by
importing `AuditModule`, injecting `AuditRecorder`, and recording after the
mutation commits — extend `AUDIT_ACTIONS` in the same commit.

## Tests

- `test/unit/audit-entry.spec.ts` — the pure actor mapping and snapshot
  sanitisation (redaction, Decimal/BigInt/Date handling, depth bound).
- `test/integration/audit.spec.ts` — a real action writes a real row attributed
  to the context actor with the correlation id; an out-of-request action is
  `SYSTEM`; the read API filters; and a failing write never throws into the
  caller.
