# SYSTEM AUDIT REPORT

**Platform:** Rami Broast — restaurant delivery platform (6 repositories)
**Audit date:** 2026-09-03
**Method:** static tracing + **live execution**. All six repositories were
installed, typechecked, linted, built and tested; a PostgreSQL instance was
provisioned, migrations applied, the API booted, and every finding below marked
VERIFIED or BROKEN was reproduced against the running system with real HTTP
requests and database inspection.

> **Status note (2026-09-03, after the audit).** Five demo-blocking items have
> since been fixed on this branch — P1-1, P1-2, P1-8 (`customer-app`), P0-1
> (`driver-app`) and P1-7 (`kitchen-pos`). This report is kept as the
> point-in-time findings record and is **not** rewritten to reflect them; the
> live tracker for what remains — including the human actions still outstanding
> on P0-1 and P1-7 — is **`PENDING_AUDIT_ITEMS.md`**.
>
> **Correction (2026-09-04) — P0-1 understated the exposure.** This report
> scoped the committed Google Maps key to `driver-app`. The **same key was also
> committed to `customer-app/app.json`** (commit `cbdaf7e`), where it sat on
> `main` in the current file, in two places, until `6332ab3` on 2026-09-04.
> The table row below reading "Key present (and committed) in `driver-app`;
> **empty** in `customer-app`" is therefore wrong: it was present and committed
> in both. This does not change the remedy — rotation at Google was always the
> only thing that revokes it — but it widens the history purge to two
> repositories and means the key was reachable for longer, by more people, than
> recorded here. Found while porting the customer-app audit work onto `main`.
>
> **Correction — ZATCA is out of scope, and this report was wrong about it.**
> The client confirmed on 2026-09-03 that ZATCA e-invoicing, tax invoices,
> credit notes and the invoice QR are dropped entirely; the restaurant issues
> its own invoice through its own systems (a decision already recorded in
> `DEMO_DECISIONS.md` on 2026-08-17, which this report did not weigh properly).
>
> Everything below that treats ZATCA as a **production blocker** or a **legal
> requirement this platform fails** is therefore withdrawn. The obligation
> belongs to the restaurant, not to this software, and it is met elsewhere.
> The "ZATCA: 0%" completeness score is withdrawn with it: scoring an
> out-of-scope capability at zero and averaging it in understated the platform.
> Excluding it, production readiness rises from 35 to roughly 45 and the
> **overall score from 60 to about 63** — the remaining production blockers
> (real payments, the concurrency defects, printing) are unaffected and still
> govern the NO verdict below. See `PENDING_AUDIT_ITEMS.md` → *Out of scope*.

---

## Executive Summary

### Overall status: **NOT PRODUCTION READY** — and **not demo-ready without four fixes**

The backend is, with important exceptions, a genuinely well-built system. Money
handling, VAT arithmetic, branch isolation, authentication, refund limits and
webhook signature verification were tested adversarially and held. 658 automated
tests pass. There is essentially no dead code, no TODO debt, no fake data and no
debug logging.

Three classes of problem stop it short:

1. **Concurrency.** The order state machine and the delivery-assignment path
   both use read-then-write checks with no database guard. Under concurrent
   requests they produce corrupt state — an order that is simultaneously
   `CONFIRMED` and cancelled, one delivery assigned to four drivers at once.
   Reproduced live, repeatedly. The codebase's own standing rule ("an
   application-level uniqueness check is not a guarantee") is correctly applied
   to coupons and payments, and not applied here.
2. **The customer app is disconnected.** Two wrong API paths mean a customer
   cannot list branches and cannot price a cart. The customer journey fails at
   the first screen. It also points at `localhost` by default.
3. **Fail-open payment defaults + a committed secret.** `PAYMENT_SANDBOX`
   defaults to `true` and is *not* refused in production; in that state an
   unauthenticated public endpoint marks any order PAID. A live Google Maps API
   key is committed to `driver-app` and is in git history.

None of these is architectural. All are bounded, well-localised fixes.

### Answer to the closing question

> *"Can this system safely be deployed to a real restaurant with real customers,
> real payments, real branches and real drivers?"*

## **NO.**

Justification, in order of weight:

- **Real payments cannot be taken at all.** The only working gateway is a mock.
  The Tap adapter is an explicit stub that throws. This is deliberate and
  documented — but it means "real payments" is not a capability the system has.
- **Order state can be corrupted by ordinary concurrent use** (two staff acting
  at once on a busy Friday). Evidence below: an order carrying `status=CONFIRMED`
  together with `cancelledAt` and a cancellation reason.
- **Real customers cannot order** — the customer app's first two API calls both
  return 401.
- **Cash on delivery — the one payment method that does work — is never recorded
  as received.** Every COD order reports `capturedMinor: 0` forever.
- **A secret is committed** and must be rotated, not merely deleted.
- ZATCA e-invoicing (a legal requirement for a Saudi restaurant) is not built.
  This is a documented, deliberate scope decision, not an oversight.

With the P0/P1 list below fixed, a **cash-and-mock-payments client demo** is
achievable quickly. Production additionally requires the Tap integration, ZATCA,
object storage, printer hardware validation and a pre-launch security pass.

---

## Repository Status

| Repository | Build | Typecheck | Lint | Tests | Functional | Security | Integration | Status |
|---|---|---|---|---|---|---|---|---|
| `backend` | PASS | PASS | PASS (0 warn) | **658 pass** (351 unit / 172 integration / 135 e2e) | Strong, 3 concurrency defects | 1 fail-open default | Serves all 4 apps | **READY WITH FIXES** |
| `admin-app` | PASS | PASS | PASS | 16 tests (thin) | Fully backend-driven | OK | Complete | **READY WITH FIXES** |
| `kitchen-pos` | PASS | PASS | PASS | 49 tests | Good | OK | Complete | **READY WITH FIXES** |
| `driver-app` | PASS | PASS | PASS | 29 tests (incl. every screen mounted) | Good | **Committed API key** | Complete | **NOT READY** (secret) |
| `customer-app` | PASS | PASS | PASS | 54 tests (no screen mounts) | **Broken at first screen** | OK | **2 wrong paths, localhost URL** | **BROKEN** |
| `infrastructure` | n/a (config only) | n/a | n/a | n/a | Config-as-code, nothing provisioned | Secrets handled correctly | Documented | **BLOCKED on client** |

`customer-app` is measurably the least-maintained repository: it is the only one
with no `CLAUDE.md`, no error boundary, no screen tests, a `localhost` default
API URL, and it missed a route split that every other client received.

---

## Feature Audit

| Feature | Frontend | Backend | Database | Integration | Status |
|---|---|---|---|---|---|
| Staff auth (email/password) | ✔ | ✔ | ✔ | ✔ | **VERIFIED** |
| Customer auth (OTP) | ✔ | ✔ | ✔ (argon2-hashed) | ✔ | **VERIFIED** |
| Token refresh / rotation / reuse-revocation | ✔ | ✔ | ✔ | ✔ | **VERIFIED** |
| Server-side logout | ✗ **no client calls it** | ✔ | ✔ | ✗ | **BROKEN** |
| RBAC (4 roles) | ✔ | ✔ | ✔ | ✔ | **VERIFIED** |
| Branch isolation | n/a | ✔ | ✔ | ✔ | **VERIFIED** (7 attack vectors) |
| Menu CRUD + variants/add-ons | ✔ | ✔ | ✔ | ✔ | **VERIFIED** |
| Branch availability (sold-out) | ✔ | ✔ | ✔ | ✔ | **VERIFIED** |
| Pricing / VAT | display only | ✔ | ✔ snapshot | ✔ | **VERIFIED** |
| Cart → order (customer) | ✔ built | ✔ | ✔ | ✗ **401 on 2 calls** | **BROKEN** |
| Counter order (POS) | ✔ | ✔ | ✔ | ✔ | **VERIFIED** |
| Order state machine | ✔ | ✔ | ✔ | ✔ sequential / ✗ concurrent | **BROKEN (race)** |
| Order idempotency | ✗ | ✗ | table unused | ✗ | **NOT IMPLEMENTED** |
| Online payment (mock gateway) | ✔ | ✔ | ✔ | ✔ | **VERIFIED (MOCKED gateway)** |
| Online payment (Tap) | — | stub throws | ✔ | — | **NOT IMPLEMENTED** (documented) |
| Webhook signature verification | n/a | ✔ | ✔ | ✔ | **VERIFIED** |
| Webhook idempotency | n/a | ✔ | ✔ unique | ✔ | **VERIFIED** |
| Refunds | ✔ | ✔ | ✔ | ✔ | **VERIFIED** |
| Cash on delivery | ✔ | ✔ partial | ✔ | ✗ never marked paid | **PARTIALLY VERIFIED** |
| Driver assignment | ✔ | ✔ | ✔ | ✗ race | **BROKEN (race)** |
| Driver **re**assignment | ✗ | ✗ | ✗ | ✗ | **NOT IMPLEMENTED** |
| Driver leg (pickup→delivered) | ✔ | ✔ | ✔ | ✔ | **VERIFIED** |
| Proof of delivery | ✔ | ✔ | ✔ | mock uploader | **MOCKED** |
| Driver location / live tracking | ✔ | ✔ | ✔ | ✔ | **PARTIALLY VERIFIED** (no real Maps key in customer/admin) |
| Coupons | ✗ **no customer UI** | ✔ | ✔ | ✗ | **PARTIALLY VERIFIED** |
| Loyalty | admin only | ✔ | ✔ | ✗ no customer UI | **PARTIALLY VERIFIED** |
| Notifications (SMS/push) | — | ✔ | ✔ | mock providers | **MOCKED** |
| Realtime (WebSocket) | admin only | ✔ | n/a | ✗ POS + customer poll | **PARTIALLY VERIFIED** |
| Banners | admin ✔ | ✔ | ✔ | ✗ **customer app never fetches** | **BROKEN** |
| Homepage builder | admin ✔ | ✔ | ✔ | ✗ **customer app never fetches** | **BROKEN** |
| Customer-app config (§24) | admin ✔ | ✔ | ✔ | ✗ never fetched | **BROKEN** |
| Promotions | ✗ **no UI at all** | ✔ 7 endpoints | ✔ 2 models | ✗ | **UNUSED** |
| Reports (sales/VAT/payments/drivers) | ✔ | ✔ | ✔ | ✔ | **VERIFIED** (see COD caveat) |
| Settlements | ✔ | ✔ | ✔ | no real payout file | **PARTIALLY VERIFIED** |
| Printing | ✔ mock | n/a | n/a | ✗ **QZ client never loaded** | **BROKEN / MOCKED** |
| File & image upload | ✗ URL fields only | ✗ no endpoint | URL columns | ✗ | **NOT IMPLEMENTED** |
| ZATCA / e-invoicing | — | README only | models exist | — | **NOT IMPLEMENTED** (deliberate) |
| Audit log | ✔ | ✔ | ✔ append-only | ✔ | **VERIFIED** |

---

## Critical Issues

| ID | Sev | Component | Issue | Evidence | Recommendation |
|---|---|---|---|---|---|
| **P0-1** | P0 | `driver-app` | **Live Google Maps API key committed** to `app.json` (twice) and present in git history (commit `ed4023f` "Add Google Maps mobile API key"). Violates the project's own non-negotiable rule #1. | `driver-app/app.json:22,30` — `AIzaSyBICLr_…`; `git log -S"AIzaSy"` returns the commit. | **Rotate the key at Google first**, then remove from the file, inject via EAS secret / build env, and purge history. Apply Android/iOS app restrictions + API restrictions to the replacement. |
| **P0-2** | P0 | `backend` order engine | **Order status transitions are not concurrency-safe.** `OrdersService.applyTransition` validates against a status read outside the transaction, then issues an unconditional `tx.order.update`. Concurrent accept + cancel both commit. | 3× accept and 3× cancel fired concurrently on one order: `OrderStatusHistory` recorded **3 CONFIRMED and 3 CANCELLED**; final row: `status=CONFIRMED`, `cancelledAt=17:17:55.166`, `cancellationReason='race'`. Sequentially the same calls correctly 409. | Replace the unconditional update with a conditional one inside the transaction — `tx.order.updateMany({ where: { id, status: order.status }, … })`, throw `ConflictException` when `count === 0` — or `SELECT … FOR UPDATE` the order row first. The coupon module already uses the conditional-update pattern correctly; mirror it. |
| **P0-3** | P0 | `backend` payments | **Fail-open sandbox defaults.** `PAYMENT_GATEWAY` defaults to `mock` and `PAYMENT_SANDBOX` defaults to **`true`**, and neither is refused when `NODE_ENV=production` (unlike `OTP_DEMO_FIXED_CODE`, which is correctly refused). In that state `POST /webhooks/payments/:gateway/simulate` is **public and unauthenticated** and marks any order PAID. | Live, no token: `POST /api/v1/webhooks/payments/mock/simulate {"gatewayPaymentId":"…","outcome":"SUCCEEDED"}` → `200 {"status":"processed"}`; order moved `PENDING_PAYMENT → AWAITING_ACCEPTANCE`, payment `PENDING → PAID`. | Refuse `PAYMENT_SANDBOX=true` and `PAYMENT_GATEWAY=mock` at boot when `NODE_ENV=production`, exactly as the OTP override is refused (`src/config/configuration.ts:186`). Default `PAYMENT_SANDBOX` to `false`. |
| **P1-1** | P1 | `customer-app` | **Customer cannot list branches.** App calls `GET /branches` (the staff route, `branches:read`) as a public call. The `/branches` → `/customer/branches` split was applied to `kitchen-pos` but never to `customer-app`. | `customer-app/src/api/endpoints.ts:47`; live `GET /api/v1/branches` unauthenticated → **401 UNAUTHENTICATED**. `GET /api/v1/customer/branches` → 200 and returns exactly the shape `Branch` already declares. | One-line change to `/customer/branches`. Add the call to `test/e2e/client-contracts.e2e-spec.ts` in the same commit. |
| **P1-2** | P1 | `customer-app` | **Checkout can never price a cart.** `quote()` is sent with `public: true`, which *skips the bearer token*; `POST /pricing/quote` is authenticated. Fails even for a signed-in customer. | `customer-app/src/api/endpoints.ts:54`; live unauthenticated quote → **401**; the same quote with a customer token → 200. `CheckoutScreen.tsx:42` gates the whole screen on it. | Remove `public: true`. This is called out verbatim in the backend `CLAUDE.md`. |
| **P1-3** | P1 | `backend` delivery | **Driver assignment race.** `DeliveryService.assignDriver` reads `driver.isAvailable` *outside* the transaction and updates unconditionally. | (a) Same driver concurrently assigned to 4 different deliveries → all 4 succeeded, driver held 4 active deliveries. (b) 4 different drivers concurrently assigned to the **same** delivery → all 4 succeeded, 4 `DeliveryStatusHistory` ASSIGNED rows, 4 drivers marked busy, 3 of them with no job. Sequentially both correctly reject. | Conditional update inside the transaction: `tx.driver.updateMany({ where: { id, isOnline: true, isAvailable: true }, … })` and `tx.delivery.updateMany({ where: { id, status: PENDING_ASSIGNMENT }, … })`; throw when either affects 0 rows. |
| **P1-4** | P1 | `backend` delivery | **No driver reassignment, and deactivation strands deliveries.** `POST /drivers/:id/deactivate` succeeds while the driver holds active deliveries; the delivery machine has no `ASSIGNED → ASSIGNED` path and there is no unassign endpoint, so the delivery can never be given to anyone else. | Deactivated a driver holding 2 `ASSIGNED` deliveries → `201`, deliveries unchanged. Reassigning one to an available driver → **409 "This delivery cannot be assigned right now."** Only escape is cancelling the order. | Add an unassign/reassign path (`ASSIGNED → PENDING_ASSIGNMENT`, freeing the driver), and block deactivation while active deliveries exist — or reassign them as part of it. §15 of the audit brief requires reassignment. |
| **P1-5** | P1 | `backend` payments | **COD payments are never settled.** Nothing sets a `CASH_ON_DELIVERY` payment to `PAID`. `CashCollectionService` reads the payment to compute variance but never updates its status. | Full COD lifecycle driven to `DELIVERED` with `collectedMinor = 22500 = expected`, variance 0 → order `paymentStatus` stayed **`PENDING`**. `/reports/payments` then reports `CASH_ON_DELIVERY: capturedMinor 0`, while `/reports/sales` reports `22500` realised. | Mark the COD payment `PAID` (captured = collected) when cash collection is recorded, inside that transaction. Until then the Payments report understates cash revenue by 100%. |
| **P1-6** | P1 | `backend` orders | **No order-creation idempotency.** The `IdempotencyRecord` table exists in the schema and **no code reads or writes it**. Payments and refunds are idempotent; order creation is not. | `grep -rn "idempotencyRecord" src/` → no hits. 8 identical concurrent `POST /customer/orders` → **8 distinct orders** (1000002–1000009). | Honour an `Idempotency-Key` header on order creation using the existing table. Audit §28 and §33 both require this; a mobile retry after a timeout duplicates a real order today. |
| **P1-7** | P1 | `kitchen-pos` | **Real printing cannot work as shipped.** `QzTrayPrinter` reads `globalThis.qz`, but the QZ Tray **JavaScript client** (`qz-tray.js`) is neither an npm dependency nor a `<script>` in `index.html`. Installing the QZ Tray desktop app does not create `window.qz`. | `grep -i qz package.json index.html` → no hits; `src/print/printer.ts:101` returns "QZ Tray is not running on this machine." unconditionally. `infrastructure/docs/deploy-kitchen-pos.md:64` says only that the desktop client is installed per machine. | Add the QZ Tray client library to the build (or document a per-machine script injection) and validate against real hardware. Until then printing is **mock-only** and the branch cannot print a kitchen ticket. |
| **P1-8** | P1 | `customer-app` | Default API base URL is **`http://localhost:3000/api/v1`** (cleartext, and wrong for any build). Every other app defaults to the deployed Cloud Run URL. | `customer-app/app.json` → `extra.apiBaseUrl`; `src/api/config.ts` fallback. | Set the real HTTPS base URL for demo/staging builds. |

---

## Broken Flows

```
CUSTOMER → Open app → Choose branch
FAILURE: GET /branches returns 401 (staff-only route called publicly).
         The customer never reaches the menu.
Severity: P1 (blocks the entire customer journey)
```

```
CUSTOMER → Cart → Checkout → see total
FAILURE: POST /pricing/quote sent without a bearer token → 401.
         The checkout screen can never display a payable total,
         signed in or not.
Severity: P1
```

```
BRANCH STAFF (admin app) + BRANCH STAFF (POS) act on one order simultaneously
FAILURE: Both writes commit. Order ends CONFIRMED while carrying
         cancelledAt + cancellationReason. Both appear in the audit history.
Severity: P0 (data corruption; the order ships despite being cancelled)
```

```
BRANCH → Ready → Assign driver (two dispatchers, or a double-click)
FAILURE: One delivery assigned to N drivers; N drivers marked unavailable.
         N-1 drivers are now blocked from all work with no job.
Severity: P1
```

```
DRIVER → COD delivery → collect cash → ADMIN → Payments report
FAILURE: Cash recorded and reconciled, but the payment stays PENDING.
         Payments report shows captured = 0 for all cash revenue,
         contradicting the Sales report for the same period.
Severity: P1 (financial reporting is internally inconsistent)
```

```
ADMIN → Upload banner / build homepage / set customer-app config
FAILURE: Stored correctly, published correctly — and no client ever
         requests /banners, /homepage/sections or /customer/config.
         The customer app renders none of it.
Severity: P2 (feature is invisible end-to-end)
```

```
ADMIN → Deactivate a driver who is mid-delivery
FAILURE: Succeeds. Delivery is now unassignable and uncompletable.
         Only recovery is cancelling the customer's order.
Severity: P1
```

---

## Security Findings

### Verified strong (tested adversarially, live)

| Control | Evidence |
|---|---|
| **Branch isolation** | 7 vectors from a BR-002 admin against BR-001: read order by id → 403; list `?branchId=` → 403; unfiltered list → 0 rows; search by the exact 12-digit reference → 0 rows; transition order → 403; edit availability → 403; read settings → 403. |
| **Customer isolation (IDOR)** | Customer B against Customer A's order: read / cancel / pay / delivery → **404** on all four (not 403 — ids cannot be probed). |
| **Driver isolation (IDOR)** | Driver acting on another driver's delivery: read → 404, `picked-up` → 404. |
| **Privilege separation** | Customer token → `GET /orders` 403, `GET /reports/sales` 403. |
| **Price integrity** | Client-supplied `unitPriceMinor` / `priceMinor` rejected by `forbidNonWhitelisted`: *"property unitPriceMinor should not exist"*. Every price is resolved server-side. |
| **Payment integrity** | Unsigned webhook → 401; wrong signature → 401; order stayed unpaid in both cases. Replayed valid webhook did not double-capture (10500 → 10500). |
| **Refund limits** | Over-refund (99999 vs 10500 captured) → 400 with the remaining refundable; same `idempotencyKey` returned the *same* refund; money did not move until the refund webhook. |
| **Coupon concurrency** | 6 concurrent redemptions of a `totalUsageLimit: 1` coupon → **exactly 1 applied**, 5 rejected. (Correct DB-level guard — the pattern missing from orders/deliveries.) |
| **Deactivation** | Deactivating a user invalidated the *existing* access token immediately (401) and blocked re-login — sessions are revoked and the actor is re-resolved per request. |
| **Brute force** | Login throttled: 10× 401 then 429. |
| **Secrets in logs** | Request bodies are not logged at all; explicit redaction list covers auth, card, signature and PII paths. No OTP, token or password found in the running log. |
| **OTP storage** | argon2id-hashed, single-use, resend cooldown enforced. |
| **Transport headers** | Helmet: CSP, HSTS (1 year, includeSubDomains), `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, COOP/CORP. |
| **CORS** | An arbitrary `Origin` is **not** reflected. |
| **Error hygiene** | Single stable envelope with a `code` and correlation id; no stack traces; permission errors never name the missing permission. |
| **Demo affordance** | `OTP_DEMO_FIXED_CODE` is refused at boot when `NODE_ENV=production`. |

### Vulnerabilities

| Sev | Finding |
|---|---|
| **P0** | Live Google Maps API key committed in `driver-app/app.json` and in git history. Rotate, do not merely delete. |
| **P0** | `PAYMENT_SANDBOX=true` + `PAYMENT_GATEWAY=mock` are the **defaults** and are not refused in production; in that state a **public, unauthenticated** endpoint marks any order PAID. |
| **P2** | **Cross-branch driver exposure.** `DriversService.listForStaff` takes no actor and applies no branch filter. A BR-002-only admin listing `/drivers` received **all 25 drivers org-wide** with full name, email, licence number, vehicle plate, online status and **live GPS coordinates**. Drivers have no `branchId` in the schema, so this is a data-model gap as much as a filter gap. |
| **P2** | **No server-side logout.** `POST /auth/logout` exists and is called by **no client**. All four apps discard the token locally only, so the 30-day refresh token stays valid — material on a shared branch POS terminal or a lost driver phone. |
| **P3** | WebSocket gateway uses `cors: { origin: true }` (reflect any). Defensible — auth rides in the handshake token, not a cookie — but it should be pinned to known origins. |
| **P3** | No request timeout in any client HTTP layer (no `AbortController` deadline); a hung request hangs the screen indefinitely. |

**Not found** (searched): SQL injection surface (Prisma parameterised throughout; the one raw statement is the order-number `INSERT … ON CONFLICT`), path traversal, unsafe file handling (there is no file handling), other committed secrets, credentials in source.

---

## Database Findings

**Schema quality is high**: 60+ models, UUIDv7 keys, integer minor units with a
`Minor` suffix, `Decimal(6,4)` VAT rates snapshotted per order *and* per line,
soft deletes on financial records, append-only audit and ledger tables, and real
uniqueness constraints where money is involved (`PaymentWebhookEvent
(gatewayName, gatewayEventId)`, `Refund.idempotencyKey`, `CouponUsage.orderId`,
`Settlement (gatewayName, settlementReference)`, `Order (branchId, orderNumber)`).

| Sev | Finding |
|---|---|
| P0 | **No optimistic-concurrency guard on `Order.status`.** The correctness of every transition depends on application-level checking. See P0-2. |
| P1 | **`IdempotencyRecord` is defined and entirely unused** — a table that advertises a guarantee the system does not provide. |
| P1 | **Contradictory column state is reachable**: `status=CONFIRMED` with `cancelledAt` and `cancellationReason` populated. No constraint prevents it. |
| P2 | **`Driver` has no `branchId`**, so drivers cannot be branch-scoped at the data layer (root cause of the cross-branch exposure and of any driver being assignable to any branch's delivery). |
| P2 | **20+ foreign keys have no covering index**, including `Order.customerAddressId`, `Order.couponId`, `Notification.orderId`, `PaymentWebhookEvent.orderId`/`paymentId`, `OrderItem.productVariantId`, `OrderStatusHistory.changedByUserId`. Fine at current volume; these become lock-contention and slow-join sources at scale. |
| P3 | `Order.referenceId` carries both `@unique` and a redundant `@@index`. |
| — | **Verified:** the price snapshot is immutable — soft-deleting a product and changing its price left an existing order's `productName`/`unitPriceMinor`/`totalMinor` untouched, and the deleted product could no longer be ordered. |

---

## Performance Findings

Measured against the running API (small dataset — these are smoke figures, not
load-test results; **no load testing was performed**).

| # | Finding | Sev |
|---|---|---|
| 1 | `GET /orders?limit=25` returns **92 KB** for 25 rows — the list endpoint serialises full nested item detail. The single largest response in the API. | P2 |
| 2 | 20+ unindexed foreign keys (above). | P2 |
| 3 | `DriversService.listForStaff` returns **all** drivers org-wide, unfiltered — response and query grow with the whole fleet for every branch user. | P2 |
| 4 | `kitchen-pos` and `customer-app` **poll** for order changes although a working WebSocket gateway exists and only `admin-app` consumes it — N branches × poll interval of avoidable load. | P2 |
| 5 | `admin-app` ships a **456 KB** single JS bundle (125 KB gzipped), no code splitting. | P3 |
| 6 | No pagination cap audit: `limit=100` accepted on driver lists. | P3 |
| 7 | Latency at current volume is healthy: orders 25 ms, deliveries 15 ms, reports 14 ms, customers 10 ms. | — |
| 8 | No caching layer anywhere (menu is re-queried per request). Acceptable now; the menu is the obvious cache candidate. | P3 |
| 9 | No connection-pool or query-timeout configuration surfaced in config. | P3 |
| 10 | Reports aggregate in the database rather than in application memory — correct, and the main reason report latency is flat. | — |

---

## Integration Findings

| Link | Status | Notes |
|---|---|---|
| Customer ↔ Backend | **BROKEN** | 2 of 16 calls hit wrong/unauthenticated routes; both are on the critical path. |
| Branch POS ↔ Backend | **VERIFIED** | All 20 calls resolve to real routes. |
| Driver ↔ Backend | **VERIFIED** | All 13 calls resolve; no customer phone exposed to the driver (confirmed by inspecting the payload). |
| Admin ↔ Backend | **VERIFIED** | All 96 calls resolve. Dashboard is 100% backend-sourced (`/reports/*`), no client-side computation. |
| Payments ↔ Backend | **VERIFIED (mock only)** | Signature verification, idempotency and refund rules all hold. Tap adapter is an explicit throwing stub. |
| ZATCA ↔ Backend | **NOT IMPLEMENTED** | `src/zatca/` and `src/invoices/` are README-only and are not imported by `AppModule`. Honest placeholders, not dead code pretending to work. |
| Notifications ↔ Backend | **MOCKED** | SMS and push ports with mock adapters; dispatch is post-commit and failure-swallowing, so it cannot break an order. |
| Maps ↔ Clients | **PARTIAL** | Key present **and committed in both** `driver-app` and `customer-app` — see the 2026-09-04 correction at the top of this report; this row originally recorded `customer-app` as empty and was wrong. |
| Printing ↔ Branch | **BROKEN** | QZ client library never loaded — see P1-7. |
| Storage ↔ Backend | **NOT IMPLEMENTED** | No upload endpoint anywhere (`FileInterceptor`/`multer`: 0 hits). Banner and product images are free-text URL fields — no upload, no type/size validation, no orphan cleanup. Audit §23 and §36 are unmet. |
| Realtime ↔ Clients | **PARTIAL** | Gateway authenticates on handshake, resolves the actor from the DB and joins only scope-appropriate rooms (verified by reading; **not** load-tested). Only `admin-app` subscribes; `emitToCustomer` has no consumer. |

### Orphaned backend surface (built, no client)

`/promotions` (7 endpoints, 2 models) — **entirely unused**.
`/customer/config`, `/customer/me` + `PATCH`, `/customer/notifications`,
`/customer/loyalty`, `PATCH /customer/addresses/:id`, `/customer/orders/quote`,
`PATCH /orders/:id/items/:itemId` (order edits), `POST /auth/logout`,
`/banners` and `/homepage/sections` from the customer side.

---

## Feature Completeness Score

Scored on **verified working functionality**, not on UI presence.

```
Admin:       85%   Complete, backend-driven, well covered. Loses points for
                   thin tests (16) and for Banners/Homepage/Customer-config
                   having no downstream consumer.
Branch POS:  80%   Every flow verified end to end except printing, which is
                   the app's defining purpose and cannot reach hardware.
Customer:    45%   Well-built screens on top of two broken API calls. The
                   journey does not start. No coupon, loyalty, notification,
                   profile, banner or homepage integration. No error boundary.
Driver:      75%   Full leg verified, privacy respected. Loses points for the
                   committed key, mocked proof upload, no reassignment path,
                   and no earnings model (documented business gap).
Backend:     80%   Excellent design and coverage; three concurrency defects
                   and one fail-open default are real and reproducible.
Payments:    55%   Mock rails are correct and defensible. Real payments are
                   not implemented, and COD never settles.
ZATCA:        0%   Deliberately out of scope. Legally required before launch.
Printing:    25%   Ticket builders correct and tested; real path non-functional.
Reporting:   80%   Arithmetic reconciles exactly against source orders; the
                   cash/payments contradiction is the deduction.
Security:    75%   Strong and adversarially verified, with two P0s and a
                   cross-branch data exposure.
```

---

## Final System Score

| Dimension | Score | Why |
|---|---:|---|
| Functional completeness | 62 / 100 | Backend near-complete for scope; customer app broken; printing, storage, ZATCA, real payments absent. |
| Security | 70 / 100 | Isolation, price, payment and session controls verified strong; committed secret and fail-open payment defaults are serious. |
| Reliability | 55 / 100 | Three reproducible concurrency defects, no order idempotency, unrecoverable stranded deliveries. |
| Data integrity | 65 / 100 | Excellent schema and snapshot discipline, undermined by reachable contradictory order state. |
| Performance | 75 / 100 | Healthy latency and DB-side aggregation; unindexed FKs, oversized list payloads, avoidable polling. Never load-tested. |
| Production readiness | 35 / 100 | Cannot take real payments, cannot issue a legal invoice, cannot print, has a live key in git. |

# **OVERALL SCORE: 60 / 100**

**Why 60.** This is a *high-quality codebase that is not a finished product*.
The engineering standard is visibly above average: one pricing choke point, one
transition choke point, gateway-neutral adapters, honest README-only stubs where
credentials are missing, 658 passing tests, a redaction list, zero TODO debt, and
branch isolation that survived seven deliberate attacks. That earns the upper
half of the range.

It is held out of the 70s and 80s by defects that are *invisible to tests and
fatal in production*: the concurrency bugs pass every sequential test and corrupt
data the moment two people act at once; the customer app compiles, typechecks and
ships while being unable to make its first two API calls; a live API key sits in
git. The gap between "the tests are green" and "this works under real use" is
exactly what this audit was commissioned to find, and it is wide here.

---

## Final Recommendation

### MUST FIX BEFORE CLIENT DEMO

1. **P1-1** `customer-app` → `/customer/branches` *(one line)*
2. **P1-2** `customer-app` → remove `public: true` from `quote()` *(one line)*
3. **P1-8** `customer-app` → real HTTPS API base URL *(config)*
4. **P0-1** Rotate the Google Maps key, remove it from the repo and history
5. **P1-7** Load the QZ Tray client, or state plainly that the demo prints preview-only

Items 1–3 are trivial edits that currently make the customer app undemoable.
Add both calls to `test/e2e/client-contracts.e2e-spec.ts` so they cannot regress.

### MUST FIX BEFORE PRODUCTION

6. **P0-2** Conditional-update guard on every order transition
7. **P0-3** Refuse `PAYMENT_SANDBOX=true` / `PAYMENT_GATEWAY=mock` in production; default sandbox to `false`
8. **P1-3** Conditional-update guard on driver assignment and delivery status
9. **P1-4** Driver reassignment path; block deactivation while a delivery is active
10. **P1-5** Settle the COD payment when cash is recorded
11. **P1-6** Order-creation idempotency using the existing table
12. Real Tap adapter (blocked: official docs + merchant credentials)
13. ZATCA e-invoicing (blocked: CR/VAT data + official specs) — **legal requirement**
14. Object storage + upload endpoints (blocked: infra) — proof of delivery and images
15. Printer validation against each branch's actual hardware
16. Server-side logout wired into all four apps
17. The Phase 19 pre-production security pass

### SHOULD FIX (P2)

- Branch-scope the drivers list; add `Driver.branchId` (stops live-GPS leakage across branches)
- Wire banners, homepage sections and customer config into the customer app, or remove the admin UI for them
- Add coupon entry, loyalty balance, notifications and profile editing to the customer app
- Add an `ErrorBoundary` to `customer-app` (the only app without one) and screen-mount tests (`driver-app` has both — copy the pattern)
- Decide on `/promotions`: build a UI or delete the module
- Add the missing foreign-key indexes
- Raise `admin-app` test coverage beyond 16 tests for 11k LOC
- Subscribe `kitchen-pos` and `customer-app` to the existing WebSocket instead of polling
- Add request timeouts to the client HTTP layers

### OPTIONAL (P3)

- Pin the WebSocket CORS origin
- Slim the `/orders` list payload; code-split the admin bundle
- Drop the redundant `referenceId` index
- Menu response caching

### VERIFIED WORKING (reproduced live, not inferred)

- Staff login, customer OTP login, token refresh/rotation, deactivation revoking live sessions
- RBAC across all 4 roles (OWNER, BRANCH_ADMIN, KITCHEN, DRIVER)
- **Branch isolation** — 7 attack vectors, all correctly refused
- **Customer and driver IDOR protection** — 404, not 403
- **Server-side price authority** — client price fields rejected outright
- **VAT arithmetic** — 2 × 100.00 SAR VAT-inclusive → base 17391 + VAT 2609 = 20000 exactly; and with fees, 20000 + 1500 delivery + 1000 charge → base 19565 + VAT 2935 = 22500 exactly
- Order placement, per-branch order numbers from 1000000, unique 12-digit references
- **Order-number allocation under concurrency** — 8 concurrent orders → 8 distinct sequential numbers, no gaps, no duplicates
- **Coupon concurrency** — 6 concurrent redemptions of a single-use coupon → exactly 1 applied
- Sequential state machine — illegal transitions rejected 409 with a clear message
- Full delivery lifecycle: READY → auto-created delivery → assign → picked up → out for delivery → delivered
- COD cash collection: server-side variance, one immutable record, duplicate → 409
- Driver privacy: no customer phone number in any driver payload
- Payment: initiate never marks paid; only a signature-verified webhook does; forged and unsigned webhooks refused; replay does not double-capture
- Refunds: over-refund refused, idempotency key honoured, money moves only on the refund webhook
- Branch closure: closed branch vanishes from the public list and rejects orders
- Snapshot immutability: deleting a product and changing its price leave historical orders untouched
- Reports reconcile **exactly** with source orders (sales, VAT by snapshotted rate, charges, driver stats)
- Rate limiting, security headers, CORS non-reflection, error envelope, log redaction

---

## Appendix — Audit Environment

- PostgreSQL 16 provisioned locally; all migrations applied via `prisma migrate deploy`; demo data seeded.
- Backend built (`nest build`) and run from `dist/` at `NODE_ENV=development`, API prefix `/api/v1`.
- Accounts created via `npm run staff:create`: OWNER, two BRANCH_ADMINs on different branches, KITCHEN, DRIVER; two customers via OTP.
- Test totals: backend 351 unit + 172 integration + 135 e2e; `kitchen-pos` 49; `customer-app` 54; `driver-app` 29; `admin-app` 16. **All passing.**
- Route inventory: **155** backend routes extracted and diffed against **144** client call sites across the four apps.
- **Not performed** (and therefore not claimed): load/stress testing, penetration testing, real gateway or ZATCA integration testing, physical printer testing, iOS/Android device testing, and any production-environment verification.
