# Architecture

How the backend is put together, why, and the rules every future module must
uphold.

**Status:** Phase 18 of 20 delivered. Foundation, data model, authentication,
RBAC, branch isolation, menu/VAT, orders, payments, refunds, notifications,
coupons/loyalty, delivery/drivers and settlements/reports are implemented —
every backend phase that does not require external credentials, official ZATCA
specs, physical POS hardware or production sign-off. The remaining modules
(`invoices`/`zatca`, and a real gateway adapter) are named against the phase
and the business input that unblocks them.

---

## 1. System context

The backend is the brain. PostgreSQL is the system of record. The apps are
clients — they render and collect, they do not decide.

```
┌──────────────┐  ┌───────────┐  ┌────────────┐  ┌─────────────┐
│ customer-app │  │ admin-app │  │ driver-app │  │ kitchen-pos │
└──────┬───────┘  └─────┬─────┘  └─────┬──────┘  └──────┬──────┘
       │                │              │                │
       └────────────────┴──────┬───────┴────────────────┘
                    authenticated REST /api/v1
                               │
                      ┌────────▼────────┐
                      │  backend (this) │────► PostgreSQL
                      └────────┬────────┘
                               │
   ┌──────────┬────────────┬───┴────┬──────────┬─────────────┐
   ▼          ▼            ▼        ▼          ▼             ▼
  Tap       ZATCA        Maps    SMS/OTP     Push     Object storage
```

Apps never call each other. Everything crosses the backend, which means every
rule below is enforced in exactly one place.

### Repository responsibilities

| Repository | Responsibility |
| --- | --- |
| `backend` | API and all business logic — auth, RBAC, branches, menu, orders, payments, VAT, invoices, ZATCA, refunds, delivery, coupons, loyalty, notifications, settlements, reports, audit |
| `customer-app` | Customer ordering, checkout, tracking, invoices, loyalty |
| `admin-app` | Owner and branch management, refunds, reports, settings |
| `driver-app` | Assignments, navigation, delivery updates, proof of delivery |
| `kitchen-pos` | Kitchen queue, printing, POS/printer adapters |
| `infrastructure` | Docker, environments, CI/CD, monitoring, backups, IaC |

---

## 2. Why a modular monolith

One deployable, hard module boundaries inside it.

Payments, VAT, coupons and loyalty are **modules**, not services and not
repositories. A restaurant delivery platform at this scale gains nothing from
distributed transactions across an order, its payment and its invoice — and
loses a great deal, because those three must agree. They stay in one process,
under one database transaction, where consistency is enforceable.

Extraction stays possible: modules communicate through service interfaces, so a
future scaling decision can lift one out. That decision must be explicit and
justified — not assumed.

---

## 3. Foundation layer (implemented)

| Concern | Implementation | Guarantee |
| --- | --- | --- |
| Configuration | `src/config/` | Validated at boot; the app refuses to start on bad config. No module reads `process.env`. |
| Logging | `src/logger/` | Structured JSON, correlation IDs, an explicit redaction list. |
| Errors | `src/common/filters/` | One envelope for every failure; internal detail never reaches a client. |
| Database | `src/prisma/` | Connection lifecycle tied to Nest, clean shutdown. |
| Health | `src/health/` | Liveness (no dependencies) and readiness (verifies the database). |
| Authentication | `src/auth/` | OTP and password login, rotating tokens, per-request actor resolution. |
| Isolation | `src/branches/` | Branch access guard and query-scoping helpers. |
| HTTP config | `src/bootstrap.ts` | Helmet, CORS, body limits, prefix and versioning — shared by `main.ts` and the e2e tests so they cannot drift. |

### Request pipeline

```
request
  → helmet                      security headers
  → correlation ID              inbound header honoured, else minted
  → rate limiter                global; health probes exempt
  → route + version match       /api/v1/...
  → auth guard                  actor resolved from DB; @Public() to opt out
  → permissions guard           @RequirePermissions(...)
  → branch isolation guard      @BranchScoped(...)
  → validation pipe             unknown properties rejected
  → controller → service → Prisma
  → exception filter            single error envelope
response
```

All four guards are global rather than scattered through controllers, so a new
endpoint is protected because it exists. `@Public()` is the only way to open a
route, which makes every unauthenticated endpoint an explicit, greppable
decision in review — currently six: five auth endpoints and the health probes.

### Error envelope

Every failure, from every endpoint:

```json
{
  "statusCode": 409,
  "code": "CONFLICT",
  "message": "A record with these values already exists.",
  "details": ["optional field-level messages"],
  "timestamp": "2026-01-01T12:00:00.000Z",
  "path": "/api/v1/orders",
  "correlationId": "3f1a0c2e-..."
}
```

`code` is a stable enum (`src/common/constants/error-codes.ts`) — clients branch
on it, never on `message`. Three properties are enforced by tests:

- **5xx never carries a real message.** Driver text, SQL and credential
  fragments are replaced with fixed generic wording.
- **Prisma errors are translated, not forwarded.** Prisma names tables and
  columns in its messages; clients get schema-free wording instead.
- **Stack traces never appear in a response.**

### Logging and redaction

Correlation IDs thread request → logs → error body, so a customer complaint maps
to exact log lines.

`src/logger/logger.module.ts` holds the redaction list: authorization headers,
cookies, API keys, gateway signatures, passwords, OTPs, tokens, and cardholder
fields. The card paths exist even though the platform must never receive a PAN —
so that a mistake upstream is redacted rather than persisted. **Extend this list
whenever a module starts accepting sensitive input.**

---

## 4. Domain modules

Each directory under `src/` carries a `README.md` with its full rules. Summary:

| Module | Phase | Core obligation |
| --- | --- | --- |
| `auth` | 4 ✅ | OTP for customers, role-aware staff login. Tokens are not authorization on their own. |
| `users` | 4 | Staff CRUD and role assignment endpoints (model and seeding done). |
| `branches` | 5 ✅ | Branch isolation — the guard every other module depends on. |
| `customers` | 9 | Customer, CustomerAddress. Own data only. |
| `menu` | 6 ✅ | Catalog, branch-aware. Price edits never touch history. |
| `vat` | 7 ✅ | **The** pricing authority. Clients never compute the payable amount. |
| `orders` | 8 ✅ | Lifecycle, status history, price snapshots. Opens/cancels the delivery leg (Phase 14) at its one transition choke point. |
| `payments` (+`tap`) | 11 ✅ | Gateway orchestration (mock working; Tap a stub). Client success is not proof. Webhook ingestion lives here (`payments.webhook.controller.ts`), not in a separate `webhooks` module. |
| `refunds` | 12 ✅ | Full/partial, never exceeding refundable, never assumed instant. |
| `invoices` | 13 | Invoice, lines, credit/debit notes, linked to order and payment. |
| `zatca` | 13 | Official documentation only. Nothing invented. |
| `drivers` | 14 ✅ | Driver profile, shift status, availability, live location. Not branch-owned. |
| `delivery` | 14 ✅ | Assignment and the driver-facing leg, kept in lockstep with `Order.status`. Privacy-safe contact means never handing a driver the raw customer phone number — no masking provider exists to do better. |
| `notifications` | 16 ✅ | Provider abstraction so vendors are swappable. |
| `coupons`, `loyalty` | 17 ✅ | Atomic reuse prevention; append-only points ledger. |
| `settlements` | 18 ✅ | Reconciliation against gateway payouts, never order totals. Discrepancies flagged, not hidden. |
| `reports` | 18 ✅ | Sales/VAT/payment reports over snapshotted data, branch-isolated. |
| `audit` | 19 | Append-only record of every financial and authorization action. |

---

## 5. The rules that shape the design

### Branch isolation

`OWNER` reaches every branch. `BRANCH_ADMIN` and kitchen/POS users reach only
assigned branches. `DRIVER` reaches own profile and assigned deliveries.
`CUSTOMER` reaches own data.

Enforced **server-side on every protected query and mutation**. A hidden button
in an admin app is not access control — the request behind it must fail.

Implemented as a guard plus query-scoping helpers, so isolation is structural
rather than something each endpoint remembers:

| Helper | Use |
| --- | --- |
| `assertBranchAccess(actor, branchId)` | A branch named in the request |
| `@BranchScoped('branchId')` | Declarative form of the above, checked by a guard before the handler runs |
| `branchScopeFilter(actor)` | A Prisma `where` fragment for list queries |
| `resolveRequestedBranches(actor, id?)` | Optional `?branchId=` filters |

`branchScopeFilter` returns an unrestricted `{}` **only** for an owner. An actor
with no assignment gets `{ branchId: { in: [] } }`, which matches nothing. That
asymmetry is the whole point: if the mistake is ever made, it must fall towards
an empty list, never towards the entire organisation's data.

### Authorization is resolved, not asserted

An access token carries identity only — actor id and kind. Roles, permissions
and branch scope are read from the database on **every** request.

That costs a query per request. It buys immediate revocation: removing a role or
a branch assignment takes effect on the next call rather than whenever the
holder's token expires. For a system where a dismissed branch manager holds a
valid token, a stale-privilege window is not an acceptable trade. If the query
ever becomes a bottleneck, cache it with an explicit short TTL and invalidation
on role change — do not move the claims into the token.

### Sessions

Access tokens are short-lived and stateless. Refresh tokens are opaque random
values, stored only as SHA-256 hashes, and rotated on every use.

Rotation carries reuse detection: presenting an already-rotated token means the
token was replayed, which in practice means it was stolen, so the entire session
family is revoked. That signs out the attacker and the legitimate holder
together — correct, once a credential is known to be compromised.

Refresh tokens are hashed with SHA-256 rather than Argon2. That is not an
inconsistency with password storage: these are 256 bits of randomness with no
low-entropy guess space to slow an attacker over, and lookup must be a single
indexed query rather than a scan of every row.

### Payment and order status are separate

`Order.status` tracks fulfilment; payment state lives on `Payment`. Neither is
derived from the other. An order can be `PREPARING` while a refund is pending;
a payment can succeed while an order is later cancelled.

```
PENDING_PAYMENT → PAID/CONFIRMED → PREPARING → READY
  → DRIVER_ASSIGNED → PICKED_UP → OUT_FOR_DELIVERY → DELIVERED

Terminal/alternative:
  PAYMENT_FAILED · CANCELLED · REFUND_PENDING · REFUNDED · PARTIALLY_REFUNDED
```

### Never trust the client on money

```
app                 backend                  Tap
 │  create order      │                       │
 ├───────────────────►│  price + VAT computed │
 │                    ├──────────────────────►│  payment created
 │  ◄─── redirect ────┤                       │
 │                    │  ◄─── webhook ────────┤
 │                    │  verify signature     │
 │                    │  verify with gateway  │
 │                    │  then mark paid       │
```

A client saying "payment succeeded" changes nothing. Only a verified webhook or
a server-initiated gateway check advances payment state.

### One pricing authority

```
items + modifiers + taxable fees − eligible discounts
  = taxable base → VAT → final total
```

Computed only in `vat/` (`VatService`), stored as a snapshot on the order.
Clients display totals; they never decide the charge — the quote endpoint takes
product IDs and quantities and no prices at all, so a tampered cart changes
nothing about what is charged.

**Settled by the owner: the standard rate is 15%.** It lives in configuration
rather than in code, because a statutory rate can change — and when it does,
only new orders are affected, since every order and invoice line snapshots the
rate it was charged at.

Two mechanics worth knowing:

- **VAT is computed per line, then summed** — not computed once on the order
  total. Invoices carry per-line tax and a credit note must mirror the line it
  reverses; apportioning an order-level figure back down reintroduces rounding
  differences exactly where an auditor checks.
- **Discounts are allocated across lines by the largest-remainder method**, so
  the parts sum to the discount exactly. Each line's taxable base then reflects
  its own share, which keeps per-line VAT right on a discounted order.

Two invariants are asserted on every quote, and the engine refuses to produce
one that violates them:

```
taxableBase + vat === total
sum(line totals) + sum(fee totals) === total
```

A silent one-halala discrepancy is what makes an invoice impossible to reconcile
against its payment months later.

### Idempotency

Every financial operation carries an idempotency key: payment creation, refunds,
and webhook processing. Gateways retry, networks duplicate, users double-tap. A
replayed request must produce the same result, not a second charge.

### Snapshots over references

Orders store the price, VAT breakdown and item details **as they were at
purchase**. Menu prices change; history does not. Reports and invoices read the
snapshot, never the current catalog.

---

## 6. Data model

**Implemented in Phase 3** — 44 tables, 26 enums, 72 foreign keys. See
`prisma/schema.prisma`; the conventions block at the top of that file is the
authoritative statement of the rules below.

### Conventions

- **Identity:** UUIDv7 primary keys — unguessable, so an ID cannot be
  enumerated, yet time-sortable so they index well. `orderNumber` and
  `invoiceNumber` are separate human-readable fields. `orderNumber` counts per
  branch from 1000000 by owner decision, so it is sequential and unique only
  within its branch; `Order.referenceId`, a random 12-digit number, is the
  globally unique public handle and the one safe to use for lookup, because a
  sequential public ID leaks order volume and lets one customer probe for
  another's order.
- **Money:** integer minor units (halalas) with an explicit currency, and a
  `Minor` suffix on every field name so the unit is unambiguous at the call
  site. Never `Float` — binary floating point cannot represent decimal money
  exactly, and a tax audit will find the drift. Settlement aggregates are
  `BigInt`, since `Int` minor units cap at roughly 21 million SAR.
- **VAT rates:** `Decimal(6,4)`, snapshotted per order and per invoice line, so
  a future rate change cannot rewrite historical tax.
- **Timestamps:** UTC. `createdAt`/`updatedAt` on mutable records; append-only
  tables carry `createdAt` only.
- **Deletion:** soft deletion (`deletedAt`) on financial and audited records.
  Ledger and audit tables are never deleted.

### Where the rules live in the schema

| Rule | Enforcement |
| --- | --- |
| Payment ≠ order status | `Order.status` and `Order.paymentStatus` are separate columns, neither derived |
| Price history is immutable | `OrderItem` snapshots name and price; `productId` is `SetNull`, never `Cascade` |
| Coupons cannot be reused | `CouponUsage.orderId` unique — two concurrent redemptions, one insert |
| Webhooks are idempotent | `PaymentWebhookEvent(gatewayName, gatewayEventId)` unique |
| Financial ops are idempotent | `idempotencyKey` unique on `PaymentAttempt` and `Refund`; `IdempotencyRecord(scope, key)` unique |
| Loyalty balance cannot drift | `LoyaltyAccount` has **no** balance column — balance is `SUM(LoyaltyTransaction.points)` |
| Branch isolation is data-backed | `UserRole.branchId`, null meaning org-wide (OWNER) |
| Financial records survive | `Restrict` on delete for branches, customers, payments and invoices with dependents |

Each of these has an integration test that proves the database rejects the bad
write — an application-level check is not a guarantee, because two concurrent
requests can both pass it.

### Deliberately absent

ZATCA-specific invoice fields (invoice hash, previous-invoice hash, UUID, QR
payload, signed XML, clearance status) are **not** modelled. They are Phase 13
and must follow official ZATCA documentation for the applicable phase/wave.
Guessing them would be a compliance failure, not a bug.

---

## 7. Environments

| | Database | Integrations | Access |
| --- | --- | --- | --- |
| development | local | sandbox/mock | open |
| staging | isolated, production-like | sandbox/test | restricted |
| production | managed, backed up | live | tightly restricted, monitored |

Separate credentials per environment, always. Live financial and tax
integrations require explicit approval before they are switched on.

---

## 8. Decisions

| Decision | Rationale |
| --- | --- |
| NestJS + TypeScript | Module boundaries and DI that match the domain; typing that matters for money. |
| PostgreSQL | Transactional integrity for order/payment/invoice consistency. |
| Prisma | Reviewable migrations; typed access. |
| Modular monolith | Consistency where it matters; extraction stays possible. |
| REST + OpenAPI | Five heterogeneous clients generate from one contract. |
| Pino | Structured logs with redaction as a first-class feature. |
| Integer minor units | Floating-point money is a correctness bug waiting to be found by an auditor. |
| Snapshots on orders | History must not move when the menu does. |

---

## 9. Open questions

Requiring merchant, accountant or ZATCA confirmation — **not to be guessed**:

1. **VAT treatment.** The 15% rate is settled. Two treatments are implemented as
   the conventional handling and are configurable, but need accountant
   confirmation before production:
   - `PRICES_INCLUDE_VAT=true` — catalog prices already contain VAT, matching
     Saudi consumer pricing.
   - `DELIVERY_FEE_TAXABLE=true` — the delivery fee forms part of the taxable
     supply.
   Discounts reduce the taxable base (applied before VAT), which is the standard
   treatment and is covered by tests.
2. The restaurant's ZATCA phase/wave and its clearance vs. reporting obligations.
3. Tap merchant eligibility for Apple Pay and mada, and settlement timing.
4. Refund policy: window, partial-refund rules, who may authorise.
5. Loyalty point reversal on partial refunds.
6. Data retention periods for invoices and audit logs.

Each is recorded here rather than resolved by assumption. An invented tax rule
is a compliance failure, not a bug.
