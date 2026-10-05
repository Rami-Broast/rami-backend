# backend

Central backend API and business logic for the restaurant delivery platform.

This service is the **source of truth** for customers, branches, menu, pricing,
VAT, orders, payments, refunds, invoices, ZATCA e-invoicing, delivery, coupons,
loyalty, notifications, settlements, reports and audit logs. The five client
repositories talk to this API; they never talk to each other and never hold
business rules of their own.

> **Current state: Phase 18 of 20 (settlements/reports) delivered.**
> Every buildable backend phase is in place: foundation, data model, auth,
> RBAC, branch isolation, the menu catalog, the pricing/VAT engine, the order
> engine, payments (mock gateway), refunds, notifications, coupons/loyalty,
> delivery/drivers, and now settlement reconciliation and reporting. A customer
> can place an order, pay online (sandbox) or with cash on delivery, have it
> cooked, and — for delivery orders — assigned to a driver and tracked through
> pickup to drop-off; staff can reconcile a gateway payout against our own money
> records and pull sales/VAT/payment reports. The remaining phases are
> hard-blocked on business input or approval: ZATCA e-invoicing (13) and the
> real Tap adapter need official specs plus merchant/legal data; production (20)
> needs sign-off. See [Implementation status](#implementation-status).

---

## Contents

- [Quick start](#quick-start)
- [Architecture](#architecture)
- [Project layout](#project-layout)
- [API conventions](#api-conventions)
- [Configuration](#configuration)
- [Testing](#testing)
- [Git workflow](#git-workflow)
- [Implementation status](#implementation-status)

---

## Quick start

**Requirements:** Node.js 22+, and either Docker or a local PostgreSQL 16.

```bash
# 1. Install
npm install

# 2. Configure — copy the reference and fill in local values
cp .env.example .env
#    At minimum set DATABASE_URL.

# 3. Start PostgreSQL
docker compose up -d postgres

# 4. Create the schema and seed roles/permissions
npm run prisma:deploy
npm run prisma:seed

# 5. Create the first staff account (never seeded — see below)
STAFF_EMAIL=owner@example.com \
STAFF_PASSWORD='a strong password' \
STAFF_NAME='Owner Name' \
STAFF_ROLE=OWNER \
npm run staff:create

# 6. Run
npm run start:dev
```

> **No staff account is ever seeded.** Seeding one would put a known account —
> and possibly a known password — into every environment including production.
> `npm run staff:create` reads the password from the environment rather than a
> command-line argument, since arguments are visible to other processes and land
> in shell history.

The API is then served at `http://localhost:3000/api/v1`.

| Check | URL |
| --- | --- |
| Liveness | `GET /api/v1/health/live` |
| Readiness (verifies the database) | `GET /api/v1/health/ready` |
| OpenAPI explorer (`SWAGGER_ENABLED=true`) | `/api/docs` |

To run the whole stack in containers instead:

```bash
docker compose up --build
```

### Common commands

| Command | Purpose |
| --- | --- |
| `npm run start:dev` | Development server with hot reload |
| `npm run build` | Compile to `dist/` |
| `npm run lint` | ESLint (use `lint:fix` to autofix) |
| `npm run typecheck` | TypeScript, no emit |
| `npm test` | Unit tests |
| `npm run test:integration` | Integration tests (needs a database) |
| `npm run test:e2e` | End-to-end tests (needs a database) |
| `npm run prisma:migrate` | Create/apply a development migration |
| `npm run prisma:deploy` | Apply committed migrations (CI/deployed environments) |
| `npm run prisma:seed` | Seed roles/permissions, plus demo data in development |
| `npm run prisma:reset` | Drop, re-migrate and re-seed the local database |
| `npm run prisma:studio` | Browse the database |
| `npm run staff:create` | Provision a staff account (see quick start) |

---

## Architecture

```
customer-app ─┐
admin-app ────┤
driver-app ───┼──► backend (this repo) ──► PostgreSQL
kitchen-pos ──┘         │
                        ├──► Tap Payments        (Phase 11)
                        ├──► ZATCA / Fatoora     (Phase 13)
                        ├──► Maps                (Phase 14)
                        ├──► SMS / OTP           (Phase 4/16)
                        ├──► Push notifications  (Phase 16)
                        └──► File/object storage
```

A **modular monolith**: one deployable, with strict module boundaries inside it.
Payments, VAT, coupons and loyalty are modules here — not separate services and
not separate repositories.

Two flows define the shape of the system:

```
Payment:  app → backend → Tap → webhook → server-side verification → order
Invoice:  order → VAT engine → invoice engine → applicable ZATCA flow
```

Full detail, including the rules each module must uphold, is in
**[ARCHITECTURE.md](./ARCHITECTURE.md)**.

### Rules that constrain every feature

These are not stylistic preferences. Code that violates them does not ship.

1. **Branch isolation is server-side.** `OWNER` reaches all branches;
   `BRANCH_ADMIN` and kitchen/POS users reach only assigned branches. Every
   protected query and mutation enforces this. Hiding a control in a client app
   is never the access control.
2. **Payment status is separate from order status.** One is never inferred from
   the other.
3. **Client-side payment success is not proof of payment.** Only a verified
   server-side result or a signature-verified webhook is.
4. **The backend decides the payable amount.** Clients display totals; they
   never compute the amount charged.
5. **Financial operations are idempotent** — payments, refunds and webhook
   processing included.
6. **Historical prices are snapshotted onto the order.** Editing a menu price
   never rewrites what a past customer was charged.
7. **Secrets are never committed and never logged.**
8. **External integrations follow current official documentation.** Tap and
   ZATCA behaviour is never guessed; where credentials are missing, a mock
   adapter is built against the real interface instead.

---

## Project layout

```
backend/
├── src/
│   ├── config/          # env validation + typed configuration       [built]
│   ├── logger/          # Pino, correlation IDs, log redaction       [built]
│   ├── common/          # error envelope, filters, pagination DTOs   [built]
│   ├── prisma/          # database connection lifecycle              [built]
│   ├── health/          # liveness + readiness probes                [built]
│   ├── bootstrap.ts     # HTTP config shared by main.ts and e2e      [built]
│   ├── auth/            # OTP + staff login, tokens, guards, actor   [built]
│   ├── branches/        # branch isolation guard + query scoping     [built]
│   ├── menu/            # catalog, branch availability, cart resolve [built]
│   ├── vat/             # the pricing + VAT engine                   [built]
│   ├── orders/          # order engine, status machine, transitions  [built]
│   ├── payments/        # gateway interface, mock adapter, webhooks  [built]
│   ├── refunds/         # full/partial refunds                      [built]
│   ├── notifications/   # SMS + push provider ports                 [built]
│   ├── coupons/  loyalty/                                           [built]
│   ├── drivers/  delivery/                                          [built]
│   ├── settlements/     # gateway payout reconciliation            [built]
│   ├── reports/         # sales, VAT, payment reports              [built]
│   │
│   ├── users/  customers/                                           [planned]
│   ├── payments/tap/  invoices/  zatca/                             [planned]
│   └── webhooks/  audit/                                            [planned]
│
├── prisma/              # schema, migrations, seed                    [built]
├── test/                # unit/ integration/ e2e/
├── .github/workflows/   # CI
└── docs/                # architecture, api, payments, zatca notes
```

Directories marked `[planned]` contain **only a `README.md`** describing scope,
phase and the rules that module must satisfy. They hold no implementation. See
[`src/README.md`](./src/README.md).

---

## API conventions

- **Versioned:** every route is under `/api/v1`.
- **One error envelope**, for every failure:

  ```json
  {
    "statusCode": 404,
    "code": "NOT_FOUND",
    "message": "The requested resource was not found.",
    "timestamp": "2026-01-01T12:00:00.000Z",
    "path": "/api/v1/orders/abc",
    "correlationId": "3f1a0c2e-9f1b-4a5c-8f2d-1b2c3d4e5f60"
  }
  ```

  Clients branch on `code` (a stable enum), never on `message`. Validation
  failures add a `details` array of field-level messages. **5xx responses always
  carry a fixed generic message** — internal detail goes to the logs, not to the
  client.

- **Correlation IDs:** send `x-correlation-id` and it is threaded through every
  log line and echoed back; omit it and the server mints one. It appears in
  every error body, so a support report can be traced to exact log lines.
- **Validation:** unknown properties are rejected, not ignored — a client cannot
  smuggle an undeclared field such as `price` or `role` into a request.
- **Pagination:** `?page=` / `?limit=` (limit capped at 100).
- **Rate limiting:** applied globally by default; health probes are exempt.
- **Authentication:** `Authorization: Bearer <accessToken>`. Every route is
  protected unless explicitly marked `@Public()` — there are exactly six such
  routes (five auth endpoints and the health probes).

### Menu and pricing

| Endpoint | Purpose |
| --- | --- |
| `GET  /api/v1/branches/:branchId/menu` | Public. The menu one branch sells, at that branch's prices |
| `POST /api/v1/pricing/quote` | Price a cart — the only authority on the payable amount |
| `GET/POST/PATCH/DELETE /api/v1/menu/categories` | Catalog management (`menu:write`) |
| `GET/POST/PATCH/DELETE /api/v1/menu/products` | Catalog management (`menu:write`) |
| `GET/PATCH /api/v1/menu/branches/:branchId/…/availability` | What a branch sells (`menu:availability`, branch-scoped) |

The catalog is organisation-wide; **availability is per branch**. A branch admin
can mark an item off or override its price for their own branch, but cannot
rename a product or change what the whole chain sells. Attempting either against
another branch returns 403 without confirming that branch exists.

### Pricing and VAT

**VAT is 15%**, applied by one engine (`src/vat/`) that is the single authority
on what a customer pays.

- **Prices are VAT-inclusive.** A menu price of 32.50 SAR already contains its
  tax; the engine backs the tax out rather than adding to it.
- **The request carries no prices.** A cart is product IDs and quantities;
  everything else is read from the catalog. A client cannot influence its bill.
- **VAT is computed per line and summed**, so invoice lines and the order total
  always reconcile.
- **Money is integer minor units throughout.** Never floating point.
- The rate is snapshotted onto every order and invoice line, so a future rate
  change cannot rewrite historical tax.

⚠️ Two treatments need **accountant confirmation before production**:
prices-include-VAT, and whether the delivery fee is taxable. Both are
configurable; see `.env.example`.

### Authentication

| Endpoint | Purpose |
| --- | --- |
| `POST /api/v1/auth/customer/otp/request` | Send a login code by SMS |
| `POST /api/v1/auth/customer/otp/verify` | Exchange the code for tokens |
| `POST /api/v1/auth/staff/login` | Staff email + password |
| `POST /api/v1/auth/refresh` | Rotate the token pair |
| `POST /api/v1/auth/logout` | Revoke the session |
| `GET  /api/v1/auth/me` | The authenticated actor, resolved server-side |

Properties worth knowing:

- **Roles and branch scope are read from the database on every request**, not
  from the token. Revoking a role or a branch assignment takes effect on the
  next request rather than whenever the token happens to expire.
- **Refresh tokens rotate and detect reuse.** Presenting an already-rotated
  token revokes the whole session family, on the assumption it was stolen.
- **OTP codes are hashed, single-use, expiring and attempt-limited.** The code
  never appears in a response, a log or the database.
- **Login responses do not leak account existence.** A wrong code and an unknown
  number return the same thing; so do a wrong password and an unknown email.

### Delivery and drivers

| Endpoint | Purpose |
| --- | --- |
| `GET/PATCH /api/v1/drivers`, `.../:id`, `.../:id/deactivate` | Staff driver management (`drivers:read` / `drivers:write`) |
| `GET/PATCH /api/v1/driver/me`, `.../status`, `.../availability`, `.../location` | The driver app's own profile, shift and location |
| `GET /api/v1/deliveries`, `.../:id`, `POST .../:id/assign` | Staff delivery management, branch-isolated (`deliveries:read` / `deliveries:assign`) |
| `GET /api/v1/driver/deliveries`, `.../:id`, `POST .../:id/{picked-up,out-for-delivery,delivered,failed}` | The driver app's own deliveries (`deliveries:own`) |

Properties worth knowing:

- **A `Delivery` opens itself.** `OrdersService`'s single transition choke
  point opens one, snapshotting the customer's address, the moment a delivery
  order reaches `READY` — and cancels it if the order is cancelled before
  pickup. Neither this module nor a client has to remember to create it.
- **Assignment and every driver update move the order too, in one
  transaction.** `DeliveryService` drives `Order.status` through the same
  choke point orders itself uses, so the two records can never disagree about
  how far a delivery has got.
- **A driver reaches only their own profile and deliveries.** Ownership is
  resolved by the caller's own user id; an unowned or unknown id returns the
  same 404 so ids cannot be probed.
- **No raw customer phone number is ever handed to a driver.** No call-masking
  provider is contracted yet (blocked on business input, like SMS and maps) —
  the safe default is to omit the number rather than invent a masking scheme.
- **A delivery that fails after pickup does not touch `Order.status`.** The
  order machine only allows cancellation up to the driver hand-off — a
  deliberate, tested rule from Phase 8. A post-pickup failure is recorded on
  the delivery for staff to resolve manually; see `src/delivery/README.md`.

### Settlements and reports

| Endpoint | Purpose |
| --- | --- |
| `POST /api/v1/settlements` | Record and reconcile a gateway payout (`settlements:write`, owner-level) |
| `GET /api/v1/settlements`, `.../:id` | View settlements and their reconciled lines (`settlements:read`) |
| `GET /api/v1/reports/{sales,vat,payments}` | Sales, VAT and payment reports over a window (`reports:read`) |

Properties worth knowing:

- **Settlement is never derived from order totals.** Expected net is
  reconstructed from captured payments, completed refunds and recorded gateway
  fees — the actual money records — and compared against what the payout claims.
  A non-zero variance, or any unmatched/duplicate/missing/unexpected line, marks
  the settlement `DISCREPANCY` for a human to review.
- **Reconciliation is idempotent** per `(gateway, reference)` and
  **branch-isolated**: an organisation-wide payout is owner-only, a
  branch-scoped one reachable only by that branch's staff.
- **Reports read snapshotted data**, so a historical figure never moves when a
  menu price changes, and the VAT report groups by the rate snapshotted per
  order rather than assuming one.
- **The VAT report is gross output VAT** — refund/credit-note VAT is not netted
  (that needs the Phase 13 credit-note model); the response says so explicitly.

---

## Configuration

All configuration arrives through environment variables, is **validated at
boot**, and is exposed as a typed tree. The app refuses to start on missing or
malformed configuration rather than failing later at runtime. No module reads
`process.env` directly.

[`.env.example`](./.env.example) documents every variable — names only, grouped
by the phase that introduces them. Real values live in secret management. See
[SECURITY.md](./SECURITY.md).

---

## Testing

| Layer | Location | Needs a database | What it covers |
| --- | --- | --- | --- |
| Unit | `test/unit/` | no | Config validation, error normalisation, pagination |
| Integration | `test/integration/` | yes | Connection lifecycle, and the schema constraints that make coupons, webhooks and refunds safe |
| E2E | `test/e2e/` | yes | HTTP surface: health, versioning, error envelope, correlation IDs, security headers, CORS |

E2E tests call the same `configureApp()` that `main.ts` uses, so the tested
surface cannot drift from the served one.

```bash
npm test                  # unit
docker compose up -d postgres
npm run test:integration
npm run test:e2e
```

CI runs lint, format check, typecheck, build, all three test layers against a
PostgreSQL service container, `npm audit`, and a secret scan.

---

## Git workflow

```
feature/<name> ──► development ──► tests + review ──► main
```

`main` is production-ready and protected — **no direct pushes**. Every change
arrives by pull request with CI green.

A feature is **done** only when it is implemented, tested, documented, its
failure cases are handled, its migrations are reviewed, and its PR is reviewed.
Partial work is never described as complete.

---

## Implementation status

| # | Phase | Status |
| --- | --- | --- |
| 1 | Repository audit and architecture docs | ✅ Done |
| 2 | Backend foundation | ✅ Done |
| 3 | Database schema/migrations | ✅ Done |
| 4 | Authentication/RBAC | ✅ Done |
| 5 | Branch isolation | ✅ Done |
| 6 | Menu/catalog | ✅ Done |
| 7 | Pricing/discounts/VAT | ✅ Done |
| 8 | Order engine | ✅ Done |
| 9 | Customer app integration | ⬜ (client repo) |
| 10 | Admin app integration | ⬜ (client repo) |
| 11 | Tap payments/webhooks | ✅ Done (mock gateway); real Tap adapter stubbed, blocked on docs+credentials |
| 12 | Refunds/reconciliation | ✅ Refunds done; settlement/reconciliation is Phase 18 |
| 13 | ZATCA e-invoicing | ⬜ |
| 14 | Driver/delivery | ✅ Done |
| 15 | Kitchen/POS | ✅ Kitchen queue done (Phase 8, `orders:kitchen`); printer/POS integration blocked — needs hardware inspection (spec §15) |
| 16 | Notifications | ✅ Done |
| 17 | Coupons/loyalty | ✅ Done |
| 18 | Settlements/reports | ✅ Done |
| 19 | Security/full testing | 🟡 Ongoing — security rules enforced and tested throughout; a dedicated hardening/pen-test pass is pre-production |
| 20 | Staging/production/handover | ⬜ Blocked on approval + business input |

### What Phase 2 delivered

Boot-time environment validation · typed configuration · structured JSON logging
with correlation IDs and secret redaction · a single API error envelope with no
internal-detail leakage · global validation with unknown-property rejection ·
global rate limiting · Helmet security headers · CORS closed by default ·
Prisma connection lifecycle · liveness/readiness probes · OpenAPI (opt-in) ·
graceful shutdown · multi-stage non-root Dockerfile · docker-compose ·
unit/integration/e2e harnesses (69 tests) · CI with dependency and secret
scanning.

### What Phase 3 delivered

The full data model: 44 tables, 26 enums, 72 foreign keys, in one reviewed
migration that applies cleanly from an empty database.

Money is stored as integer minor units (never floating point) with VAT rates as
exact decimals snapshotted per order. Primary keys are UUIDv7 — unguessable but
index-friendly — with human-readable order and invoice numbers kept separate.
Order numbers count per branch from 1000000 (each branch runs its own series),
and every order also carries a globally unique, random 12-digit `referenceId`
that is the safe public handle for looking one up.

The constraints that matter are enforced by the database, not by application
discipline: coupon reuse, webhook replay and refund double-submission are all
blocked by unique constraints, so two concurrent requests cannot both succeed.
Loyalty balances are derived from an append-only ledger with no stored counter
to drift. Order items snapshot what was sold, and survive the product being
deleted. 29 integration tests prove each of these by attempting the bad write.

ZATCA-specific invoice fields are deliberately absent — Phase 13, from official
documentation.

### What Phases 4-5 delivered

Customer OTP login and staff password login, both issuing short-lived access
tokens with rotating refresh tokens. Passwords and OTP codes are hashed with
Argon2id; refresh tokens are stored as SHA-256 hashes, so a database leak yields
no usable session. Refresh reuse is treated as theft and revokes the family.

Authorization is resolved from the database per request, never read from the
token, so revocation is immediate. Four guards run globally — throttle,
authentication, permissions, branch access — which means a new endpoint is
protected because it exists, not because someone remembered to decorate it.

Branch isolation is structural: `assertBranchAccess` for a named branch and
`branchScopeFilter` for list queries. An actor with no branch assignment gets a
filter matching *nothing*, never everything — the direction that mistake falls
is the difference between an empty list and a data breach.

An SMS port with a mock adapter carries OTP delivery until a provider is
contracted, so nothing about a real SMS API had to be invented.

### What Phases 6-7 delivered

A branch-aware catalog: one organisation-wide menu, with each branch controlling
what it currently sells and optionally at what price. Customers browse a branch
menu without signing in; staff manage the catalog under `menu:write` and branch
availability under `menu:availability`, the latter guarded by branch isolation.

The pricing engine, which is the single authority on the payable amount. VAT at
15%, inclusive pricing, per-line tax, proportional discount allocation by the
largest-remainder method, and two invariants asserted on every quote so a
breakdown that does not add up is never produced at all.

118 tests cover this: exhaustive rounding and allocation properties, VAT
arithmetic across awkward amounts, and the end-to-end proof that a client
sending its own price is rejected rather than believed.

### What Phase 8 delivered

The order engine. A customer places an order carrying only what to buy; the
catalog and VAT engine decide every price and the full breakdown is snapshotted
onto the order and its lines, so a later menu-price change can never rewrite what
was charged. Fulfilment (`Order.status`) and money (`Order.paymentStatus`) are
separate columns that move independently — cash on delivery confirms an order for
the kitchen while payment stays pending until collection.

A pure state machine governs every transition, exposed through a single choke
point that validates the move, stamps the timestamp and appends an append-only
history row — so payments, delivery and refunds later drive status through one
audited path rather than mutating it. Branch isolation holds on every staff
route; customers reach only their own orders, and an unknown or someone-else's
order id returns an identical 404 so ids cannot be probed.

Cash on delivery is enabled per branch (never assumed). Online payment methods
create the order in `PENDING_PAYMENT`; initiating the charge is Phase 11 (Tap,
behind a gateway interface with a mock adapter until credentials and official
docs exist). 33 new tests cover the state machine, order-number generation, and
the full engine against a real database — placement guards, the price snapshot,
COD vs online, kitchen transitions, cancellation windows and isolation.

### What Phase 11 delivered

Online payments, behind a gateway interface so a gateway is one adapter rather
than an assumption baked into the code. A fully working **mock** adapter signs
its own webhooks with HMAC over the raw body and verifies them the same way, so
the platform's payment flow is real and tested before any Tap credential exists.
The **Tap** adapter is an explicit stub that refuses loudly until official
documentation and merchant credentials arrive — nothing about Tap's API is
invented.

The money rules hold end to end: initiating a charge never marks anything paid;
only a signature-verified webhook advances a payment to PAID and confirms the
order (through the order engine's one transition choke point, system-attributed).
Every financial operation is idempotent — attempts by unique idempotency key,
webhook events unique per gateway event id, so a double-tap or a replayed
delivery acts once. Unverified webhooks are recorded and rejected, never acted
on. 19 new tests cover signing and verification, the Tap stub's refusal, and the
full flow against a real database — including idempotent replay and signature
rejection.

### What Phase 12 delivered

Full and partial refunds, upholding the refund rules: only authorized staff, only
their own branch's takings, never more than the remaining refundable amount, and
idempotent by key. Completion is asynchronous — issuing a refund puts it
PROCESSING and the order into REFUND_PENDING; the money moves onto the payment
and order only when a verified gateway refund event confirms it, and a failed
refund restores the order's money state. Refunds touch only the money columns;
fulfilment is left alone. 7 new tests cover the partial-then-final lifecycle,
over-refund rejection, idempotency, non-refundable and cash-on-delivery refusal,
branch isolation, and gateway-failure restoration — against a real database.

### What Phase 14 delivered

Driver profiles and the delivery leg of fulfilment. A `Delivery` opens itself
— `OrdersService`'s single transition choke point creates one, with the
customer's address snapshotted, the moment a delivery order reaches READY, and
cancels it if the order is cancelled first; neither the delivery module nor a
client has to remember to do it, and every path that reaches those two
statuses carries the cascade automatically. From assignment onward,
`DeliveryService` drives the matching `Order.status` through that same choke
point in the same transaction as every delivery-side change, so the two
records can never disagree about how far a delivery has got.

A driver goes online, is offered for assignment, and is held unavailable for
exactly the duration of one job — never manually overridable mid-delivery.
Every self-service and driver-facing route resolves ownership by the caller's
own user id, so a driver reaches only their own profile and deliveries, with
an unowned or unknown id returning the same 404. Two gaps in the specification
are flagged rather than guessed at: no call-masking provider exists yet, so
drivers are simply never handed the customer's raw phone number instead of a
fabricated masking scheme; and a delivery that fails after pickup cannot
legally cancel its order (Phase 8's tested rule stops at the driver hand-off),
so it is recorded on the delivery alone for staff to resolve, not forced
through an invented or illegal transition. 34 new tests cover the delivery and
driver state machines, the order-opens/cancels-the-delivery cascade, the full
assignment-to-drop-off lifecycle keeping both records in step, ownership
isolation, and the post-pickup failure path — against a real database.

Kitchen/POS (Phase 15) backend surface — correct-branch order routing and the
live kitchen queue — was already delivered in Phase 8
(`orders:kitchen`, `GET /orders/kitchen/queue`). Printer/POS integration
remains hard-blocked: the specification requires inspecting the actual branch
hardware before choosing an integration method, and no hardware exists to
inspect yet.

### What Phase 16 delivered

Customer notifications for order, payment and refund events, over SMS and push
provider ports — each with a mock adapter, so the flow works before any provider
is contracted and swapping one in is a single class. Each event writes a
Notification with a per-channel delivery record, sent over both channels and
marked sent or failed. Triggers are best-effort and fire after the triggering
operation has committed, so a notification can never break an order or payment.
Copy lives in one pure catalog (English now; Arabic slots in later). 8 new tests
cover the copy and status mapping, and the end-to-end dispatch — a COD order's
confirmation and each advance, an online order staying silent until paid, and a
failed payment — against a real database.

### What Phase 17 delivered

Coupons and loyalty. Coupon eligibility is a pure, fully-tested function — rules
ANDed (first-order, minimum spend, branch, product, category, time window,
customer eligibility) with percentage/fixed/free-delivery discounts — and the
discount it produces goes through the same VAT engine as any other, so a coupon
never touches tax arithmetic and a client only ever supplies a code. Reuse
prevention is atomic in the database (unique order usage + a conditional
usage-count increment recorded inside the order transaction), not a read-check.

Loyalty is a points ledger with no stored balance — the balance is the sum of an
append-only transaction log. Points are earned on delivery and reversed on
cancellation (fully) or refund (in proportion, monotonically), which is how the
spec's requirement that refunds reverse points is met; staff can make audited
manual adjustments. The earn rate is configuration flagged for business
confirmation, never invented. 24 new tests cover coupon evaluation and the
order-integrated engine, and the loyalty ledger's earn/reverse/adjust behaviour
— against a real database.

### What Phase 18 delivered

Settlement reconciliation and reporting — the last buildable backend phase.
Reconciliation is a pure, exhaustively tested function: a gateway payout report
is matched line by line against our own records, and expected net is
reconstructed from captured payments, completed refunds and recorded gateway
fees — never from order totals, which is the specification's hard rule, because
a discount that never reached the gateway or a fee it took would be invisible
otherwise. Every line the reconciler cannot cleanly account for is flagged —
unmatched, duplicate, missing or unexpected — and any non-zero variance marks
the whole settlement a discrepancy for a human to sign off. Ingestion is
idempotent per `(gateway, reference)` and branch-isolated, with organisation-
wide payouts owner-only.

Reporting adds sales, VAT and payment reports, all reading the figures
snapshotted onto orders at purchase, so a historical report never moves when a
menu price changes; the VAT report groups by the rate snapshotted per order
rather than assuming one. The VAT report is honest about being gross output VAT
— it does not yet net refund/credit-note VAT, which needs the Phase 13
credit-note model, and it says so in the response rather than quietly
overstating. 23 new tests cover the reconciliation core in isolation and both
modules end to end against a real database — clean matches, every discrepancy
kind, idempotency, window boundaries, snapshot stability and branch isolation.

With this, every backend phase that can be built without external credentials
or business sign-off is done. What remains is genuinely blocked, not skipped:
ZATCA e-invoicing (13) needs official specs plus CR/VAT registration; the real
Tap adapter needs merchant credentials and official API docs; printer/POS
integration (15) needs the physical hardware inspected; and staging/production
(20) needs explicit approval. Each is recorded below rather than guessed at.

### Blocked on business input

Production cannot proceed without the items in section 31 of the master
specification: legal/business name, branch list, CR and VAT registration
details, menu and prices, delivery zones and fees, cancellation/refund policy,
expected transaction volume, Tap merchant credentials, ZATCA onboarding phase,
SMS/OTP, maps and push providers, POS/printer hardware, and hosting.

**Credentials must be supplied through secure secret management — never through
GitHub, chat or a file in this repository.**
