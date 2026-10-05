# Project context

Standing context for anyone — human or agent — working in this repository.
Read this before making architectural decisions. Sessions do not persist; this
file is the memory.

---

## What this is

The backend for a restaurant-owned delivery platform, built to the master
specification (`Restaurant Delivery Platform AI Agent Master Spec`). It is the
**source of truth** for customers, branches, menu, pricing, VAT, orders,
payments, refunds, delivery, coupons, loyalty, notifications, settlements,
reports and audit logs. It does **not** issue tax invoices or do ZATCA
e-invoicing — that is out of scope (see below); the restaurant handles it.

**GitHub organisation: `Rami-Broast`. Six repositories, four client apps:**

| Repository | What it is |
| --- | --- |
| `backend` | This repo. All business logic. |
| `customer-app` | Customer ordering app |
| `admin-app` | **Owner *and* branch staff — one app, two role-based views** |
| `driver-app` | Delivery partner app |
| `kitchen-pos` | Kitchen screen and printer/POS at each branch |
| `infrastructure` | Docker, CI/CD, environments, monitoring, backups |

Owner and branch panel are **not** separate apps. The same `admin-app` binary
serves both, and the backend decides what each role may see. That is precisely
why branch isolation must be enforced server-side — the client cannot be the
control.

Apps never call each other. Everything goes through this API.

---

## Confirmed product decisions

These are settled. Build toward them; do not re-litigate.

**Client demo phase — read `DEMO_DECISIONS.md` in this repo before touching
payments, invoicing, SMS, push, maps or printing.** Highlights: **Phase 13
invoices/credit notes and ZATCA are dropped from scope entirely** — reaffirmed
2026-09-03, build none of it and add no invoice QR anywhere (the restaurant
issues its own ZATCA invoice through its own systems); Tap / real SMS / real
push wait for client approval and stay mocked until then; Google Maps keys are
needed *now* for the demo; printer integration is **per-branch by model** —
never assume one printer everywhere.
Customer OTP for the demo is always `123456`.

### Online ordering and online payment via Tap — confirmed

Customers will order online and **pay online** through **Tap Payments**. This is
a confirmed requirement, scheduled for **Phase 11**, and the data model already
accommodates it end to end:

- `Payment` / `PaymentAttempt` — attempts modelled separately from orders, so a
  declined card retried successfully is one payment and two attempts.
- `PaymentWebhookEvent` — unique per `(gatewayName, gatewayEventId)`, with
  `signatureVerified` defaulting to `false`.
- `Refund` — full and partial, with a unique `idempotencyKey`.
- `GatewayFee`, `Settlement`, `SettlementTransaction` — so net revenue is
  reconstructible from source rather than inferred.
- `gatewayName` on every gateway-facing record, so Tap is one adapter behind an
  interface rather than an assumption baked into the schema.

**Nothing about Tap's API may be invented.** Implement against current official
Tap documentation. Until real credentials exist, build a mock adapter against
the same interface — never guess an endpoint, a field name, or a signature
scheme, and never fabricate a credential.

Rules that constrain the payment work, from the specification:

1. Secret gateway credentials live **only** on the backend. Never in a client
   app, never on a branch computer or POS terminal.
2. **Client-side payment success is never proof of payment.** Only a
   signature-verified webhook or a server-initiated gateway check advances
   payment state.
3. `Order.status` (fulfilment) and `Order.paymentStatus` (money) are separate
   columns. Neither is derived from the other.
4. Every financial operation is idempotent — payment creation, refunds and
   webhook processing.
5. Refunds may never exceed the remaining refundable amount, and completion is
   asynchronous. Never assume it is instant.
6. Sandbox and production credentials are strictly separated.
7. Apple Pay and mada only after merchant eligibility is confirmed.

Cash on delivery exists in the schema (`PaymentMethod.CASH_ON_DELIVERY`) but is
enabled per branch, not assumed.

### Client apps must have first-class UI/UX — confirmed

The four client apps are to be built to a high standard of design and usability,
not treated as thin wrappers over the API. When those phases arrive (9, 10, 14,
15), apply proper design practice: a shared design system and tokens, accessible
contrast and touch targets, full Arabic/RTL support alongside English, real
empty/loading/error states, and offline tolerance where the context demands it
(a driver loses signal; a kitchen screen must not go blank).

This does not change the backend rule: apps **display** totals, they never
compute the payable amount, and they never hold business rules.

---

## Non-negotiable rules

From specification section 0. Code that violates these does not ship.

1. Never commit a secret — no key, certificate, credential, password or token.
2. Never log secrets, OTPs, tokens or payment credentials.
3. Do not push directly to `main`. Use branches, pull requests and review.
4. Branch isolation is enforced **server-side on every protected query and
   mutation**. Hiding a control in a client app is not access control.
5. Do not invent payment, VAT, ZATCA, legal or security requirements. Use
   current official documentation and flag anything needing merchant or
   accountant confirmation.
6. No production changes, live payment captures or refunds, or live ZATCA
   submissions without explicit approval.
7. Do not mark a feature complete unless it is implemented, tested, documented
   and its failure cases are handled.

---

## Conventions already established

Set in Phases 2–3. Follow them; do not introduce a second way of doing these.

- **Money:** integer minor units (halalas) with an explicit currency and a
  `Minor` field suffix. Never floating point. Settlement aggregates are
  `BigInt`.
- **VAT rates:** exact decimals, snapshotted per order and per order line.
- **IDs:** UUIDv7 primary keys, kept separate from the human-readable
  `orderNumber`. `orderNumber` is **per branch and
  sequential from 1000000** (an owner decision — see Phase 8 below), so the
  globally unique, non-sequential public handle for an order is its 12-digit
  `referenceId`.
- **Time:** UTC everywhere.
- **Deletion:** soft delete on financial and audited records; ledger and audit
  tables are append-only.
- **Config:** validated at boot in `src/config/`. No module reads `process.env`
  directly.
- **Errors:** one envelope, a stable `code` enum, generic text for all 5xx.
- **Logging:** structured, correlation IDs, explicit redaction list in
  `src/logger/logger.module.ts`. **Extend that list whenever a module starts
  accepting sensitive input.**
- **Constraints belong in the database.** An application-level uniqueness check
  is not a guarantee — two concurrent requests can both pass it.

---

## Phase status

Done: 1 (audit/docs), 2 (foundation), 3 (schema/migrations), 4 (auth/RBAC),
5 (branch isolation), 6 (menu/catalog), 7 (pricing/VAT), 8 (order engine),
11 (payments — mock gateway behind an interface; real Tap adapter stubbed),
12 (refunds), 14 (driver/delivery), 15 backend surface (kitchen queue — was
already delivered in Phase 8; printer/POS integration remains blocked, see
below), 16 (notifications), 17 (coupons/loyalty), 18 (settlements/reports).
**Every backend phase that can be built without external credentials,
physical POS hardware or production sign-off is now done.**

**Phase 13 (invoicing + ZATCA) is OUT OF SCOPE, not blocked** — it is not
pending work and no one should pick it up. See `src/zatca/README.md` and
`src/invoices/README.md`. Consequence to know: the VAT report is gross output
VAT only, permanently.

Hard-blocked and deliberately not built (needs business input, never guessed):
the real Tap adapter (needs official docs + merchant credentials), printer/POS
integration within 15 (needs the actual branch hardware inspected first —
spec §15, §31), 19's dedicated pre-production hardening/pen-test pass (security
rules are enforced and tested throughout, but the final audit is a
pre-launch activity), 20 (production — needs approval), and the client-app
repos 9/10/14/15.

**VAT is settled at 15%** by the owner. Implemented in `src/vat/VatService`,
which is the only place a payable amount is decided. Prices are VAT-inclusive;
discounts reduce the taxable base; VAT is per line then summed. The rate is
snapshotted onto every order line. Do not compute a total anywhere
else, and never accept a price from a client.

Established in 4-5, and load-bearing for everything after:

- `Actor` (`src/auth/types/actor.ts`) is the authenticated caller plus its
  permissions and `BranchScope`. Resolved from the database per request.
- **Isolation helpers live in `src/branches/branch-scope.ts`.** Any query
  touching branch-owned data must use `branchScopeFilter(actor)` or
  `assertBranchAccess`. An actor with no assignment must match nothing.
- Four global guards: throttle, auth, permissions, branch. New endpoints are
  protected by default; `@Public()` is the only way to open one.
- Permission codes are seeded in `prisma/seed/permissions.ts`. Gate endpoints
  with `@RequirePermissions('orders:read')`.
- No staff account is ever seeded. Use `npm run staff:create`.
- `CatalogService.resolveCartLines` turns client cart input into server-priced
  lines. Order creation (Phase 8) must go through it and then `VatService`,
  snapshotting the result onto the order.
- The catalog is organisation-wide (`menu:write`); availability is per branch
  (`menu:availability`, branch-scoped).

Established in 8 (order engine), and load-bearing for payments/refunds/delivery:

- **`OrdersService.placeOrder`** (`src/orders/`) is the only way an order is
  created. It resolves the cart server-side, prices it through `VatService`, and
  snapshots the whole breakdown onto `Order` + `OrderItem` (+ `priceBreakdown`
  JSON). No price is ever accepted from a client.
- **`OrdersService.applyTransition` is the single choke point for status
  changes** — it validates against the pure state machine in
  `src/orders/order-status.machine.ts`, stamps the timestamp, and appends an
  `OrderStatusHistory` row. Later modules (payments, delivery, refunds) MUST
  drive status through it, not mutate `Order.status` directly. It is exported
  from `OrdersModule`.
- `Order.status` (fulfilment) and `Order.paymentStatus` (money) move
  independently — never derive one from the other.
- **Cash on delivery is per branch**: `BranchSetting.acceptsCashOnDelivery`
  (default `false`, added in migration `..._order_engine_cod_flag`). A COD order
  is CONFIRMED at placement with a pending `Payment` (`gatewayName:
  "cash-on-delivery"`); online methods leave the order in `PENDING_PAYMENT` for
  Phase 11 to advance.
- **Order numbers count per branch from 1000000.** Each branch runs its own
  series: its first order is `1000000`, its next `1000001`, and another
  branch's traffic never advances it. Allocated by `allocateOrderNumber`
  (`src/orders/order-number.ts`) with one atomic `INSERT ... ON CONFLICT DO
  UPDATE ... RETURNING` against `BranchOrderSequence`, run **inside the
  order-creation transaction** — the database serialises concurrent orders in a
  branch, and a rolled-back order returns its number instead of leaving a gap.
  Uniqueness is therefore *per branch* (`@@unique([branchId, orderNumber])`):
  two branches legitimately both have an order `1000000`.
- **`Order.referenceId` is the globally unique 12-digit public reference.**
  Because the order number is now sequential and guessable by design, this
  random reference — not the order number — is what identifies one order across
  the platform, and it is shown on the customer's order summary, the branch
  docket and every admin/POS order view. Owner decision: the sequential number
  is what staff and customers say out loud; the reference is what a lookup uses.
  Retried on the rare unique collision, guaranteed by the DB constraint.
- **Staff order lookup:** `GET /orders?search=` matches an order by its
  `referenceId`, its `orderNumber` or the customer's phone, from the start of
  the value so a half-read reference still finds it. The filter is ANDed into a
  `where` that already carries `resolveRequestedBranches(actor, …)`, so it
  widens *what* is matched and never *whose* — a branch user searching another
  branch's exact reference gets nothing, and there is an integration test that
  holds that line.
- **Branch availability is the sell/don't-sell gate.** The branch menu returns
  the whole catalogue with an `isAvailable` flag per product (a customer who
  cannot find a dish at all assumes it was discontinued). `resolveCartLines`
  rejects an unavailable item at placement, so **a client that ignores the flag
  lets someone build a cart that fails at checkout** — every client must honour
  it. `PATCH /menu/branches/:branchId/products/:productId/availability`
  (`menu:availability`, held by BRANCH_ADMIN and KITCHEN) is how a branch marks
  something sold out; `test/e2e/branch-pos.e2e-spec.ts` holds that whole loop,
  including that one branch cannot touch another's availability.
- **Counter orders (Branch POS):** `OrdersService.placeOrderForStaff` (`POST
  /orders`, `orders:write`) lets a branch member take a walk-in / phone order on
  a customer's behalf. Same server-side pricing discipline as `placeOrder`;
  branch is asserted against the caller's scope (own branch only), the customer
  is found-or-created by phone, a delivery order carries an inline address saved
  for that customer, and payment is `CASH` (counter/till — new `PaymentMethod`
  value, `gatewayName: "counter-cash"`, paid-now vs pay-on-collect via
  `cashCollected`) or `CASH_ON_DELIVERY`. Counter cash is the merchant's own
  record of a sale, so it is *not* subject to the online "success is never proof
  of payment" rule; till reconciliation of a pending counter-cash payment is
  deferred (business input).
- **The public branch list carries the branch's phone number.** A customer with
  a question about an order has to be able to ring the branch (the customer
  app's Help screen dials from this list), and it is a business contact already
  printed on the docket — not personal data. It is the branch's number only; a
  *customer's* number is still never exposed to a driver.
- **Two audiences need two paths.** `GET /branches` is the **staff** resource
  (`BranchesController`, carries `code` and `status`); the public customer list
  is `GET /customer/branches` (`CatalogController`, `@Public()`, carries the
  branch settings a customer needs). They used to share `/branches`, the public
  one won registration, and the admin Branches page silently received the
  customer projection — blank status chip, wrong lifecycle buttons, no way to
  close or archive a branch. **Nest does not warn about a duplicate path**, so
  when adding a route check nothing already serves it.
- **Client screen contracts:** `test/e2e/client-contracts.e2e-spec.ts` fires
  every request each app makes when a screen opens and asserts none is a 4xx.
  It exists because `forbidNonWhitelisted` is on: **one query parameter a DTO
  does not declare turns a whole screen into a 400 VALIDATION_FAILED**, and
  nothing else catches it — the client compiles, the route exists, the
  permission is right, and it only breaks when a human opens that tab. It also
  pins which routes are public: **`POST /pricing/quote` is authenticated**, and
  a client that omits the token gets a 401 that reads as "couldn't price your
  order". When a client starts sending a new filter, add it here in the same
  commit.
- **Client write contracts:** `test/e2e/client-writes.e2e-spec.ts` performs
  every create/update/delete the apps perform, with the body the app actually
  builds, and reads each one back. It catches two things the read side cannot:
  a field the DTO does not declare (the whole request is rejected, so the Save
  button silently never works — the admin's new-product form sent `isActive`,
  which `CreateProductDto` did not accept), and **a write that does not stick or
  quietly erases a neighbour** — so every partial update asserts the fields it
  did *not* send are unchanged. Client enums are checked here too: `CLOSED` vs
  `TEMPORARILY_CLOSED` and a non-existent charge `appliesTo` were both found
  this way.
- **Local test DB:** integration/e2e need Postgres. In a sandbox without a DB,
  run one as the `postgres` user (root cannot run `initdb`/`postgres`): `initdb`
  a datadir under `/tmp`, start on port 5432 with `-k /tmp`, and point
  `DATABASE_URL=postgresql://postgres@localhost:5432/<db>?host=/tmp`, then
  `npx prisma migrate deploy`. Unit tests need no DB.

Established in account deletion (App Store readiness):

- **`DELETE /customer/me` anonymises; it does not remove the row.** Apple
  rejects an app that creates accounts and cannot delete them from inside the
  app (Guideline 5.1.1(v)), so this endpoint exists — but `Order.customerId` is
  `onDelete: Restrict`, and those orders are the restaurant's sales and VAT
  records that every figure in `src/reports/` is built from. Deleting them would
  silently change last month's revenue. `CustomersService.deleteAccount` clears
  the name and email, blanks and soft-deletes every address, sets `isActive`
  false + `deletedAt`, revokes every refresh-token family, and leaves `Order`
  alone. Read `src/customers/README.md` before changing any of it.
- **The phone number is released**, replaced with `deleted:<customerId>`. It is
  `@unique`, so keeping the real value on a dead row would make deleting an
  account a permanent ban. The placeholder is deliberately **not** E.164:
  nothing a keypad produces can collide with it and no staff screen can dial it.
- **Retention is not guessed and not stubbed.** How long the anonymised shell
  and the order rows are kept is the restaurant's accountant's answer against
  Saudi tax-record rules. There is deliberately no config knob for it: a setting
  nothing enforces reads as a feature and is not one. Same for the purge job and
  for any grace period.
- Nothing in this codebase writes `AuditLog` yet, and this change did not become
  the first writer — that convention should be set deliberately. When it is,
  note that an audit row for *this* action must not re-store the personal data
  the action just erased.

Established in 11 (payments), and load-bearing for refunds/settlements:

- **The gateway is one adapter behind an interface** (`src/payments/gateway/
  payment-gateway.interface.ts`). Types are gateway-neutral — no Tap field names.
  `MockPaymentGateway` is the working sandbox adapter (real HMAC-signed
  webhooks). `TapPaymentGateway` is a **stub that throws** — implementing it
  needs official Tap docs + credentials; never invent them. Adapter chosen at
  boot from `PAYMENT_GATEWAY` and injected under the `PAYMENT_GATEWAY` token.
- **Client success is never proof of payment.** `PaymentsService.initiate` never
  marks anything paid; only a signature-verified webhook (`handleWebhook`)
  advances a payment to PAID and confirms the order. Verify the signature on the
  raw body — `rawBody: true` is enabled in `main.ts`; webhook events are unique
  per `(gatewayName, gatewayEventId)` for idempotency; attempts are unique per
  `idempotencyKey`.
- A verified success advances the order via `OrdersService.applyTransition(...,
  null, ...)` (system-attributed) — reuse that choke point, never mutate status.
- Sandbox completion: `POST /webhooks/payments/mock/simulate` (or
  `PaymentsService.simulateWebhook`) delivers a real signed mock webhook so the
  online flow is exercisable end-to-end without real money.
- **`PAYMENT_MOCK_AUTO_SETTLE` makes the sandbox settle its own charges.** The
  mock gateway has no hosted page and no bank, so on the demo nothing ever
  delivered that webhook: an online order stayed in PENDING_PAYMENT for ever,
  never reached the branch and never appeared on the POS. With the flag on,
  `initiate` delivers the mock's own signed success webhook through
  `handleWebhook` — the ordinary ingestion path, signature verified, order
  advanced through `applyTransition`. **This does not weaken "client success is
  never proof of payment"**: the client still proves nothing; the sandbox is
  standing in for the bank. Off by default (like `PAYMENT_SANDBOX`, the
  forgot-to-configure state must not be the one that marks orders paid) and
  turned on explicitly in `.github/workflows/deploy.yml` — which is now the
  **demo** deploy only. It goes off the day the Tap adapter lands.
- **There are two deploy workflows, and the split is load-bearing.**
  `deploy.yml` is the **demo** deploy (push to main, `NODE_ENV=staging`, pinned
  OTP, mock gateway, auto-settle). `deploy-production.yml` is production:
  manual, gated on a protected GitHub Environment, `NODE_ENV=production`, and it
  sets none of those. They are separate files rather than one parameterised
  workflow because the demo configuration is not a variant of the production one
  — it is a set of affordances that must never reach a real customer, and a
  shared workflow with a flag is one wrong input away from shipping them.
  The guards below only fire at `NODE_ENV=production`, and the demo deploy set
  `staging` precisely to route around them, so for a while the demo config was
  one merge from being the launch config.
- **Boot guards refuse demo values in production** (`src/config/
  configuration.ts`): a pinned `OTP_DEMO_FIXED_CODE`, `PAYMENT_SANDBOX`,
  `PAYMENT_GATEWAY=mock` and `PAYMENT_MOCK_AUTO_SETTLE` each fail the boot.
  `PAYMENT_MOCK_AUTO_SETTLE` is *also* refused alongside any non-mock gateway in
  **any** environment — it is meaningless there, so the combination is a
  leftover demo variable rather than a choice. `SMS_PROVIDER` is deliberately
  **not** guarded: `SmsProvider` has only `mock`, so no configuration could
  satisfy such a guard and every production boot would fail for a reason the
  operator cannot act on. Add that assertion the day a real provider joins the
  enum.
- **The gateway adapter is provided by `PaymentGatewayModule`** (own module),
  imported by both payments and refunds, so both depend on the interface via one
  shared provider.

Established in 12 (refunds):

- **`RefundsService.createRefund`** validates (never exceed `captured −
  refunded`), creates the `Refund` idempotently (unique `idempotencyKey`), moves
  the order to `REFUND_PENDING`, and calls `gateway.refund()`. Completion is
  **async** — money moves only when a verified refund webhook is applied by
  `RefundsService.applyRefundEvent`, which `PaymentsService.handleWebhook` calls
  (refund events carry `gatewayRefundId`). Refund logic is split this way to keep
  webhook ingestion in one place with no circular module dependency.
- Refunds move money on `Payment.refundedAmountMinor` / `Payment.status` and
  `Order.paymentStatus` only; **`Order.status` (fulfilment) is never touched by a
  refund** — the two columns stay independent.

Established in refund requests (the customer's side of a refund):

- **A `RefundRequest` is the ask; a `Refund` is the money.** They are two tables,
  and the separation is the feature: a refused request still has to exist, and a
  `Refund` row for money nobody moved would be a lie about the money. Read
  `src/refunds/README.md` before changing any of it.
- **What it replaced was silence.** A customer could cancel an order themselves
  only in `PENDING_PAYMENT` / `AWAITING_ACCEPTANCE` / `CONFIRMED`. Past that the
  API answered *"Please contact the branch"* and the platform held **nothing** —
  no request, no queue, no record that anyone had asked. (The customer app even
  shipped a `cancelOrder` API method that **no screen called** — the same
  built-and-inert shape as promotions and opening hours.)
- **Three parties, three acts, three permissions** (owner decision, 2026-09-07).
  The **customer** asks; the **branch** decides (`refund-requests:decide`, held
  by OWNER *and* BRANCH_ADMIN); the **owner** pays out in the payment gateway's
  own dashboard and records it (`refunds:write`, owner-only).
  `refund-requests:decide` exists apart from `refunds:write` precisely because
  reusing the latter would also have handed every branch manager the
  direct-refund button on the Payments page.
- **Approving is not paying, and this is the load-bearing rule.**
  `RefundRequestsService.approve` **never calls the gateway**. It cancels the
  order where legal, records `approvedAmountMinor`, and returns
  `AWAITING_PAYOUT` / `MANUAL_SETTLEMENT` / `CANCELLED_NO_REFUND`. An approved
  request with `refundIssuedAt` null is a **debt**: `Order.paymentStatus` still
  reads `PAID`, and the customer is told their refund is *being arranged*, never
  that it has been sent. `recordRefundIssued` is the act that writes the
  `Refund`, moves the money columns, reverses loyalty and tells the customer.
  **No screen, message or column may conflate the decision with the payout.**
- **`Refund.issuedManually` tells the two kinds apart**, and it matters
  operationally: a manually recorded refund has **no `gatewayRefundId`**, so no
  webhook will ever confirm it and nothing may sit waiting for one.
  `gatewayReference` (required) is what ties it to its line on the payout at
  reconciliation. `RefundsService.createRefund` — the gateway path with
  asynchronous webhook completion — is untouched and returns to use the day the
  real Tap adapter lands.
- **Money is the gate on cancelling yourself, not time** (owner decision,
  2026-09-08). An **unpaid** order can be cancelled outright by the customer,
  with no approval and no clock — nothing has been taken, so dropping it costs
  the branch nothing (and the state machine already refuses once the kitchen has
  started). The moment a payment is **captured** that stops being true:
  cancelling then means giving money back, which is the branch's decision, so a
  paid order gets the *request* path however early it is.
  `hasCapturedMoney` (`src/payments/captured-money.ts`) is the single definition
  both `OrdersService.cancelByCustomer` and the eligibility rule read — two
  copies would drift, and an app would offer a cancel the server refuses.
  It is enforced in `cancelByCustomer`, not only in the eligibility read: a
  client that skipped the check, or held a stale one, must still be refused.
- **Two windows, two clocks, both 10 minutes, both config.** A cancellation
  request runs **10 minutes from placement**
  (`REFUND_CANCELLATION_WINDOW_MINUTES`); a refund request runs **10 minutes
  from delivery** (`REFUND_REQUEST_WINDOW_MINUTES`) — a refund is "something was
  wrong with what arrived", which cannot be known until it arrives. Minutes on
  both, because that is the unit the owner answered in and 10 minutes cannot be
  expressed in hours. Null on either means no deadline.
- **A customer's cancellation carries a required reason**
  (`CustomerCancelOrderDto`), where staff's stays optional. The asymmetry is
  deliberate: staff act inside a branch that knows why and their reason is
  recorded against a named user, while a customer's is the branch's only account
  of why an order it was about to cook disappeared. It is stored verbatim — the
  history row already says a customer made the change.
- **The customer never chooses the type.** `RefundRequestType` is derived from
  the order's status — still on its way is a `CANCELLATION`, already delivered
  is a `REFUND`. Asking a customer to classify it is asking them to know our
  fulfilment model.
- **Eligibility is pure** (`src/refunds/refund-request-eligibility.ts`) and is
  served at `GET /customer/orders/:id/refund-eligibility` with a customer-facing
  sentence for every outcome. No client keeps a second copy of the rule, so an
  app cannot offer a button the server then refuses.
- **One open request per order, enforced by a partial unique index**
  (`WHERE status = 'PENDING'`). The application check is passed by two taps of a
  Submit button on a slow connection; the loser is handed the winner's request.
  Prisma cannot express it, so it lives in the migration — constraints belong in
  the database.
- **Approving bypasses nothing.** Cancelling goes through
  `OrdersService.cancelByStaff` — the one choke point — so the state machine,
  status history, delivery record and loyalty reversal behave as they do for any
  other cancellation.
- **Neither decision nor payout can happen twice.** The decision is guarded by
  the request's own status; the manual refund's idempotency key is derived from
  the request id rather than generated. The second press is the dangerous one:
  by then the owner has already paid out in the dashboard.
- **The approved amount is capped at the decision**, not only at payout. The
  branch says the number out loud to the customer, and discovering later that it
  was impossible means telling them twice.
- **Nothing here writes `AuditLog`.** The `RefundRequest` row is its own audited
  record — who asked, why, who decided, when, what was decided, who paid. The
  audit-writing convention still has not been set deliberately, and a
  customer-facing feature is the wrong place to set it by accident.
- Notification copy for the four moments (received / approved / declined /
  **sent**) is pure, in `notification-messages.ts`, and passed to `dispatch` as
  an override: all four are `REFUND_UPDATE`, because the type says which feed a
  message belongs in and these have very different things to say. "Approved" and
  "sent" are separate messages on purpose, often hours apart.

Established in measuring the refund windows, and pushing location to customers:

- **A refused customer is otherwise invisible, so `RefundWindowMiss` records
  them.** An approved or declined request leaves a `RefundRequest` row somebody
  can read; a customer told *"the window has closed"* leaves nothing at all —
  the eligibility rule refuses before anything is written. A window that is too
  short would therefore never announce itself: it would surface as phone calls
  to branches and complaints that never reach the platform. The row carries
  `minutesLate` and the `windowMinutes` in force at the time, because "forty
  people missed it" invites an argument while "and thirty of them by under five
  minutes" answers what the window should be.
  Written **best-effort** from `eligibilityForCustomer` and **unique per
  order** — the eligibility read runs on every order-screen open, so without
  that constraint the table would measure how often people re-check rather than
  how often we refuse, and one frustrated customer refreshing would read as
  twenty. `GET /reports/refund-window-misses` is the read, with
  `wouldHaveBeenCaughtBy` buckets.
- **`driver.location` now reaches the customer, not only branch staff.** Until
  this, the customer's tracking map redrew on its own eight-second poll, so the
  marker lagged reality by up to eight seconds on the one screen somebody
  watches *because* they want to know where their food is now. The poll stays as
  the floor (a phone in a lift still gets a marker); the push removes the wait.
- **The customer's copy is gated and smaller.** It is emitted only while the
  delivery is `PICKED_UP` or `OUT_FOR_DELIVERY` — the same window in which the
  driver may ring them (`src/delivery/customer-contact.ts`), and for the same
  reason: a driver merely ASSIGNED may still be at another drop or at the
  counter, and showing that as "your driver" is both wrong and a position nobody
  agreed to share. Staff see every ping regardless; dispatch is what the branch
  board is for. `customerId` and `orderId` on `DriverLocationPayload` are
  **routing only and stripped before the staff emit**, exactly like
  `driverUserId` on an assignment.

Established in 14 (driver/delivery):

- **A `Delivery` opens and closes itself at the order engine's one choke
  point, not in the delivery module.** `OrdersService.applyTransition` creates
  a `Delivery` (snapshotting the customer's address, same discipline as the
  price snapshot) the moment a delivery order reaches READY, and cancels it if
  the order is cancelled before pickup. This keeps the dependency
  one-directional (`delivery` → `orders`, never back), the same shape as
  refunds depending on the payment gateway interface rather than the reverse.
- **From `ASSIGNED` onward, `DeliveryService` drives both records together.**
  Assignment and every driver-initiated move (`markPickedUp`,
  `markOutForDelivery`, `markDelivered`) call
  `OrdersService.applyTransition(tx, order, ...)` in the same transaction as
  the delivery-side write, so `Delivery.status` and `Order.status` can never
  disagree about how far a delivery has got.
- **A driver holds `isAvailable=false` while carrying *any* active delivery**
  (`ASSIGNED`/`PICKED_UP`/`OUT_FOR_DELIVERY`), never manually overridable
  mid-job — see `DriversService.setAvailability`. Going offline always clears
  it; going online restores it only if no job is active.
- **A busy driver can be given another drop** (stacked assignment). Assignment
  requires only that the driver is **on shift** — batching two or three drops
  onto one run is how a small fleet works, and refusing it left food on the pass
  whenever everyone happened to be out. The ceiling is
  `DRIVER_MAX_ACTIVE_DELIVERIES` (default 3): a **safety limit, not an owner
  decision** — confirm the real number before launch, like the VAT rate and the
  loyalty earn rate. `1` restores the old one-job-at-a-time behaviour.
- **The ceiling is held by a row lock, not by a read.** `assertCanTakeAnotherJob`
  takes `SELECT ... FOR UPDATE` on the driver before counting. The old guard was
  a conditional `isAvailable: true → false` update, which the database
  serialised for free; making a busy driver assignable removed that, and without
  the lock four concurrent presses each read the same count, each passed, and
  all four landed. `test/integration/concurrency.spec.ts` fails without it.
- **`isAvailable: false` now means two different things, and the difference is
  load-bearing**: *carrying work* (assignable, up to the ceiling) versus
  *stepped away* (`setAvailability` — a break, only possible while holding
  nothing, and **not** assignable). The **active-delivery count** is what tells
  them apart, which is why the assignment guard reads it rather than the flag.
  Without that, making busy drivers assignable would have silently turned the
  break switch into a control that controls nothing.
- **`releaseAfterDelivery` frees a driver only when it was their last job**, and
  only if they are still on shift. It used to set `isAvailable: true`
  unconditionally, which was correct only while a driver could hold one job —
  with stacking it would put someone still carrying two more drops back into the
  counter's "free" column while they were riding.
- **`driver.status` is a realtime event** (`RealtimeService.driverStatus`),
  emitted when a driver goes on/off shift, steps away, takes a job or finishes
  one. It is what turns the counter's driver picker from a snapshot into a live
  list: a branch reading "no drivers on shift" used to have no way of learning
  that somebody had started theirs short of closing and reopening the dialog.
  A driver with no branch reaches owners only, which matches who can see them.
- **Coordinates cross the API as numbers, and this is not automatic.**
  `Driver.currentLatitude/Longitude` and `Delivery.distanceKm` are `Decimal`
  columns, and **`Prisma.Decimal` serialises to a JSON *string*** —
  `JSON.stringify(new Decimal('24.72'))` is `"24.72"`. Every view that selected
  them raw shipped a string where each client's type said `number`, invisible to
  both typecheckers, and it broke two screens at once: the **customer's tracking
  map** called `.toFixed()` on it and threw inside render (the error boundary,
  on the one screen that says where the food is), and the **owner's fleet map**
  got a string where a `LatLng` was needed, so the pin never landed and the map
  sat on its hard-coded fallback centre — which is what "the map opens somewhere
  random" was. `src/common/geo.ts` (`toCoordinate`) is the conversion, applied
  at every read in `DeliveryService` and `DriversService`. **Any new response
  carrying a Decimal must do the same**, exactly like the `BigInt` settlement
  aggregates. An integration test asserts the type, because nothing else can.
- **`GET /drivers` carries `activeDeliveryCount`.** `isAvailable` is a yes/no
  and a dispatcher choosing between two busy drivers needs the number — "on a
  job" and "on three jobs" are a different decision. Clients must treat an
  **absent** count as *unknown*, never as zero.
- **A post-pickup delivery failure never touches `Order.status`.** The order
  machine (Phase 8, deliberately unchanged) allows CANCELLED only up to
  DRIVER_ASSIGNED — cancelling after pickup is not a legal move. So
  `DeliveryService.markFailed` records `Delivery.FAILED` with a reason and
  frees the driver, but leaves the order exactly where it was for staff to
  resolve manually. This is a real gap in the fulfilment model as specified,
  flagged in `src/delivery/README.md` rather than closed by inventing or
  forcing an illegal transition.
- **The assigned driver can call the customer, unmasked, from pickup onward**
  (owner decision — this *reverses* the original rule, which withheld the
  number entirely). No call-masking provider is contracted and the owner has
  accepted that trade: the cost of the old default was a driver at an unmarked
  gate with a cooling bag and nobody to ring.
  The gate is `src/delivery/customer-contact.ts`, and it is narrow on purpose:
  only the driver the delivery is assigned to (`loadOwn` resolves ownership
  from the caller's own driver record), only while the delivery is **live** —
  `PICKED_UP` and `OUT_FOR_DELIVERY`, nothing else — and it is **stripped from
  the payload**, not hidden by the app, whenever the gate is closed. A field a
  screen chooses not to render is still a field anyone can read out of a
  response. The staff delivery view is unchanged.
  Both ends of that window were chosen against a specific failure. It opens at
  `PICKED_UP` rather than `OUT_FOR_DELIVERY` because the machine allows
  `PICKED_UP → DELIVERED` directly, so gating later would strand the driver who
  never pressed "Start delivery". It **closes at the drop** because a finished
  delivery is still reachable in the driver app — Home lists past jobs and every
  row opens the delivery screen — so a number surviving `DELIVERED` would not
  have been a few minutes of grace but **a standing directory of every customer
  a driver had ever delivered to**, one tap from being dialled, for as long as
  the app was installed. The after-the-drop call is not lost: a driver rings
  before pressing Failed, which is the order those happen in anyway.
  Two consequences to know: this is real personal data now leaving the platform
  onto drivers' handsets, so the **privacy notice and the retention/recipients
  tables in `infrastructure/legal/` name drivers as a recipient** — check that
  before launch; and nothing writes an `AuditLog` for it, because this codebase
  has no audit-writing convention yet (see the account-deletion note) and
  setting one deliberately is a better idea than making this the first writer.
- **`ProofOfDeliveryType.OTP` is a label only** — no challenge/verification
  flow exists yet (would need its own `OtpPurpose`, distinct from
  `CUSTOMER_LOGIN`). `SIGNATURE`/`PHOTO` are fully supported: the client
  uploads the capture elsewhere and passes back a URL; this backend never
  handles the upload.
- **Kitchen/POS (15) backend surface was already done in Phase 8** —
  `orders:kitchen`, `GET /orders/kitchen/queue`, and the staff kitchen
  transitions all predate this phase. Printer/POS integration is not started:
  the spec requires inspecting the actual branch hardware first, and none has
  been available to inspect.
- **A driver has their own realtime room, and assignment reaches it.**
  `ROOMS.driver(userId)` is keyed on the **user** id, not `Driver.id`: the
  socket gateway only ever holds an `Actor`, so this is the one identifier it
  can join on with no extra query, and every producer holds the `Driver` row
  (and its `userId`) already. The gateway joins any staff socket holding
  `deliveries:own` — the DRIVER role's only permission, held by nobody else.
  Before this a driver was a staff actor with `branchScope: NONE`, so
  `joinRooms` put their socket in **no room at all** and the driver app was
  back on its eight-second poll: "the counter assigned it" and "the driver
  knows" were up to eight seconds and a screen-state apart.
  `deliveryAssigned` now fans out to the branch **and** that driver, and
  `deliveryUnassigned` is a new event for the other direction — a job taken
  back has to leave the driver's screen, or two people set off for one pickup.
  `driverUserId` on the payload is **routing only and is stripped before the
  emit**: the branch-facing copy is read by every owner's browser.

Established in opening hours (the schedule that nothing read):

- **It was built and inert, and that shape is worth remembering.** The weekly
  schedule, the timezone handling and the date overrides had existed since the
  branch module — and *nothing consulted them*. One staff endpoint answered "is
  this branch open" and no client called it; placement never checked; and the
  admin's editor rendered **zero rows** for a branch with no hours (it mapped
  straight over a response that only carries the days that exist), so no branch
  could ever get a first schedule. The backend enforced nothing because nothing
  could be set. Same failure as the promotions module: every part present, no
  part connected.
- **The rule is pure** (`src/branches/opening-hours.ts`). `branchOpenState`
  takes the schedule, the overrides and a local `now`, and returns whether the
  branch is open, why not, and when it opens again. `localNowIn` does the
  timezone conversion separately, so a timezone bug and an off-by-one cannot
  look the same in a failure.
- **An empty schedule means unrestricted, not closed**, and this is the whole
  reason the feature was safe to ship. Every branch predates the editor, so
  reading no rows as "shut" would have refused every order on the platform the
  day it landed. `configured: false` is a returned field rather than a caller's
  assumption, and `acceptsOrdersNow(state)` is the one predicate enforcement
  uses — there is deliberately **no second, nearly-identical predicate**, since
  a pair differing in one edge case is how a caller picks the wrong one.
- **A window past midnight is read off the previous day's row.** 18:00–02:00 is
  an ordinary restaurant shift; consulting only today's rows reported a
  late-night kitchen shut for the two hours it is busiest, and a branch would
  have had to add a phantom 00:00–02:00 row to work around it.
- **Enforced for customers, not at the counter.** `placeOrder` refuses outside
  hours; `placeOrderForStaff` does not. Staff taking a walk-in are standing in
  the shop — if the schedule says shut and someone is at the counter, the
  schedule is what is wrong, and refusing the sale to defend it would be the app
  arguing with the room.
- **The quote carries `branchOpen`**, so a customer learns before choosing what
  to eat rather than on the Pay button — the same discipline as the delivery
  blockers, and for the same reason. A quote still prices the basket: the totals
  must not vanish while they decide whether to wait.
- **`/customer/branches` carries `isOpenNow`, `opensAt`, `closesAt` and
  `closedNote`**, resolved for the whole list in three queries
  (`BranchHoursService.openStates`) rather than four per branch — it is the
  first list a customer's app fetches.
- **`isAcceptingOrders` and the schedule are different things.** One is a switch
  someone flips ("not right now", no promise about when); the other runs on its
  own and knows when it opens again. Clients must keep them distinct: saying
  "opens at 17:00" for a manual pause is a promise nobody made.
- A date override **replaces** its day outright — that is what makes it useful
  for Eid and Ramadan, which suspend the weekly pattern rather than varying it —
  and a half-filled override (no times) **fails shut**, because reading missing
  times as "open all day" costs an unstaffed night.

Established in 16 (notifications):

- **`NotificationsService`** (`src/notifications/`) sends customer notifications
  over SMS + push **provider ports** (`SMS_SENDER`, `PUSH_SENDER`), each with a
  mock adapter — no real credential invented. Reuses the Phase 4 SMS port.
- **Triggers are best-effort and fired post-commit, never inside a transaction:**
  `dispatch` swallows+records failures so a notification can never break the
  order/payment flow. Orders fire on placement/transition/cancel; payments fire
  ORDER_CONFIRMED/PAYMENT_FAILED/REFUND_UPDATE after the webhook tx commits.
- Copy lives in the pure `notification-messages.ts` (English today; Arabic slots
  in there). Never template or store an OTP/credential in a notification.
- **A status with no message is a customer who hears nothing.**
  `notificationTypeForStatus` returning null means `dispatch` returns early —
  no SMS, and nothing in the app's feed. `AWAITING_ACCEPTANCE` mapped to null,
  so on a manual-accept branch a customer who had just paid was told nothing at
  all until staff got round to accepting; `ORDER_RECEIVED` now covers it. Two
  statuses stay null on purpose: `PENDING_PAYMENT` (announcing an order before
  the money clears is a message we may have to retract) and `PICKED_UP`
  (`OUT_FOR_DELIVERY` says the same thing a moment later). When adding a status,
  decide its message here rather than leaving it silent by omission — and the
  e2e contract suite asserts the customer's feed is **non-empty** after an
  order, because "the endpoint loads" was never the failure people report.

Established in 17 (coupons/loyalty):

- **Coupon eligibility is a pure function** (`src/coupons/coupon-evaluation.ts`,
  rules ANDed). `CouponsService` feeds it DB facts and returns a
  `ResolvedDiscount` that the order engine passes to `VatService` — a coupon
  never touches tax arithmetic. Order engine prices, evaluates coupon on the
  subtotal, re-prices with the discount.
- **Coupon reuse prevention is atomic in the DB**: `CouponUsage.orderId` unique +
  a conditional `usageCount` increment, recorded inside the order-creation
  transaction. Never rely on a read-then-write check.
- **An offer is a published coupon** (owner decision, 2026-09-04). `Coupon`
  carries `isPublic` (**off by default** — a coupon is as often a private,
  targeted apology as a promotion, and publishing one by accident hands its code
  to everybody) and `imageUrl`, the owner's artwork. `CouponsService.listPublic`
  serves the customer app's Offers page through `/customer/config`, filtered to
  published + active + inside its window + not exhausted, because each of those
  is a way a customer ends up staring at a code the checkout then refuses. It
  also surfaces the MIN_SPEND threshold so the card can state the condition.
  **There is no second discount path**: the card carries the very code the
  pricing engine already honours. `PATCH /coupons/:id` changes presentation and
  availability only (name, description, artwork, `isPublic`, `isActive`) —
  the code, discount, dates and limits are the terms customers were given and
  past redemptions were made under, so a different offer is a different coupon.
  `imageUrl` is a URL, not an upload: no object storage is provisioned (same
  blocked-on-infrastructure category as proof-of-delivery photos).
- **Loyalty is a ledger** (`src/loyalty/`), balance = `SUM(points)`, no counter.
  EARN on delivery (idempotent), REVERSE on cancel (full) / refund (proportional,
  monotonic), ADJUST by staff. Triggers are post-commit + best-effort (never
  break the order/payment). **Earn rate `LOYALTY_POINTS_PER_SAR` is a business
  input** (default 1, confirm before launch) — like the VAT rate, config not
  code. Redemption/expiry deferred: they need business-confirmed values.

Established in promotions (automatic discounts):

- **A promotion is a discount nobody types a code for.** The owner publishes
  one and a qualifying cart gets it at checkout. That is the whole difference
  from a coupon — which one customer claims, against usage limits and
  per-customer caps — and it is why `src/promotions/` exists beside
  `src/coupons/` rather than inside it. Read `src/promotions/README.md` first.
- **It was the worst possible half-built state and is worth remembering as a
  shape**: every endpoint worked, the permissions were seeded, the schema was
  complete, `/customer/config` served it — and **nothing applied it to a
  price**. An owner publishing "20% off burgers" had every signal it worked and
  none that it did not. A feature that looks finished and does nothing is worse
  than one that is visibly absent.
- Same shape as coupons: `promotion-evaluation.ts` is **pure and tested**,
  `PromotionsService.evaluateForCart` feeds it DB facts, and what comes out is a
  `ResolvedDiscount` for `VatService`. A promotion never touches tax arithmetic.
- **A promotion listing products is measured on those products only.** "20% off
  burgers" must not discount the drinks in the same basket. Listing none makes
  it basket-wide. The lines it is measured on come from the engine's own priced
  lines (`OrdersService.promotionLines`) — never a second implementation of
  "what is this line worth".
- **Only one promotion applies (the largest), but a promotion and a coupon now
  stack** (owner decision, 2026-09-10) — `OrdersService.resolveDiscount` applies
  both, and `couponSuperseded` is consequently always null (the field stays
  because clients render it). Nothing compounds: each amount is resolved against
  the undiscounted gross, so two 20% discounts take 40% off, not 36%. The
  engine's clamp per bucket is what stops a generous pair from reaching a
  negative total. **Which discount gave what is recorded in `OrderDiscount`**,
  at the amount actually given after that clamp — `couponId`/`promotionId` can
  no longer answer it now that both may be set, and the receipt names the offer.
  Two *promotions* stacking with each other is still refused, and is still a
  conservative default rather than an owner decision.
- `priority` breaks a tie and nothing else. It has only ever meant display
  ordering, and promoting it to the field that decides money would change what
  every existing row means.
- `Order.promotionId` records which promotion paid, beside `Order.couponId`.
  Only one is ever set; two columns is what lets a report separate "our own
  promotions" from "codes customers redeemed".
- Applied in **four** places, and all four must stay in step: the customer
  quote, `placeOrder`, `placeOrderForStaff`, and `POST /pricing/quote` — the
  last because the Branch POS prices its running total there and places through
  `placeOrderForStaff`. If only one knew about promotions, the counter would
  read out a price the till did not take.
- **`branchIds` is empty when a promotion runs everywhere.** `/customer/config`
  is branch-agnostic, so it ships `branchIds` and the customer app filters —
  otherwise it would advertise a deal only another branch runs.

Found while wiring the above, and fixed (`src/vat/order-breakdown.ts`):

- **A free-delivery discount used to be spent on the base fee only.** Beyond the
  base-fee radius the leftover was dropped, so the rows summed higher than the
  total, `assertBreakdownAddsUp` threw, and **the placement failed with a 500** —
  for the customer holding the best coupon we issue, and only when they lived
  far enough away. The rows now spend the discount on the base fee and then the
  distance fee, because the total already did. The existing test only covered a
  drop-off inside the covered distance, which is why it never fired.

Established in 18 (settlements/reports):

- **Reconciliation is a pure function** (`src/settlements/
  settlement-reconciliation.ts`). `SettlementsService` feeds it DB facts —
  captured `Payment`s, completed `Refund`s, their gateway fees — and persists
  the `Settlement`, its `SettlementTransaction` lines and a `GatewayFee` per
  fee-bearing line. **Expected net is reconstructed from those money records,
  never from order totals** (spec's hard rule §18). Actual net comes from the
  payout; `variance = actual − expected`.
- **Every payout line is classified** MATCHED / UNEXPECTED (amount or fee
  disagrees) / DUPLICATE / UNMATCHED (we have no such record) / MISSING (our
  record the payout omitted). A settlement is MATCHED only if every line
  matched and variance is 0; otherwise DISCREPANCY, for human sign-off.
- **Ingestion is idempotent** per `(gatewayName, settlementReference)` (unique
  constraint + up-front check) and **branch-isolated**: an org-wide settlement
  (branchId null) is owner-only; a branch-scoped one is reachable by that
  branch's staff. `settlements:write` is owner-level; `settlements:read` was
  added to BRANCH_ADMIN (they already see their branch's payments/refunds).
- **BigInt settlement aggregates cross the API as strings** (like Decimal) —
  `SettlementsService.serialize`. JSON cannot encode BigInt at all; there is no
  global polyfill, so any new BigInt response must be serialised the same way.
- **Reports read snapshots only** (`src/reports/`). Sales/VAT/payment reports
  over a window, branch-isolated via `resolveRequestedBranches`. "Realised
  sales" = CONFIRMED onward incl. refund states; PENDING_PAYMENT / PAYMENT_FAILED
  / CANCELLED excluded from revenue (but shown in the status breakdown). The VAT
  report groups by the **snapshotted** rate and is **gross output VAT only** —
  refund/credit-note VAT is **never** netted, because invoicing is out of scope;
  the response flags `basis: "gross"` so it is never mistaken for net.
- **The payout is submitted as gateway-neutral lines** (`gatewayReference`,
  `type`, `amountMinor`, `feeMinor`). Mapping a real gateway's payout-report
  format into that shape is an adapter concern for when credentials exist —
  same "never invent a gateway's API" rule as the Tap adapter.

Established when the Branch POS grew a Reports tab:

- **`reports:read` is now held by KITCHEN**, and it is the only financial
  permission that role has. The counter had every order on its own screen all
  day and no sum of them anywhere, so "how did tonight go" was a phone call to
  the owner; what the permission buys a branch is the *sum*, which is what an
  end-of-shift handover is. It changes nothing about isolation —
  `resolveRequestedBranches` still decides whose orders are counted, so a
  counter cannot read another branch's revenue — and the rest of the financial
  set stays withheld: payments as the gateway's own records, refunds,
  settlements, and `orders:cancel`.
  `test/e2e/client-contracts.e2e-spec.ts` asserts a KITCHEN account loads all
  four report reads. That assertion is load-bearing and was checked by
  reverting the grant on a fresh database, where it fails.
- **Nothing about the reports themselves changed.** The POS reads the same
  `/reports/sales|vat|payments|dashboard-kpis` the admin panel does, over the
  same inclusive window. Worth knowing for the client side: the window the POS
  sends is built from the **branch's own local calendar day**, not a UTC day.
  Riyadh runs at UTC+3, so a UTC window would move three hours of a branch's
  trade into the wrong day's figures every day, and nothing on either side
  would say so — see `kitchen-pos/src/util/reportRange.ts`.

Established in delivery pricing (owner decision, 2026-09-04):

- **The owner's confirmed numbers**: delivery minimum **40 SAR**, base fee
  **5 SAR covering the first 5 km**, **3 SAR per started km** beyond that. Every
  one is a **column on `BranchSetting`**, editable per branch from the admin
  panel — like the VAT rate, config not code. Do not hard-code them anywhere.
- **The arithmetic is a pure function** (`src/delivery-pricing/
  delivery-pricing.ts`). `CatalogService.quoteDelivery` feeds it branch rules
  and a distance and returns the whole breakdown; `assertDeliverable` is what
  refuses a placement. **A quote never throws** — a basket below the minimum
  still returns totals plus a `shortfallMinor`, because the moment a customer
  most needs to see how much more to add is the moment the totals must not
  vanish.
- **Distance is straight-line × `deliveryRoadFactor` (1.3)**, not a routing
  API. No routing provider is contracted — same blocked-on-business-input
  category as SMS and call masking. Google Distance Matrix is a drop-in for
  `deliveryDistanceKm` when someone approves the spend.
- **An unmeasurable distance is charged the base fee and never refused.** An
  address saved without a map pin, or a branch with no coordinates, produces
  `distanceKm: null`. Turning a paying customer away over our own missing data
  is the more expensive error.
- **Distance is charged per *started* kilometre.** 5.1 km on a 5 km base is one
  chargeable km. A fractional charge produces a fee nobody can repeat by hand.
- **`minOrderMinor` is the *delivery* minimum and is measured on items only**,
  before the fee — a customer must not reach it by living further away. It is
  deliberately **not** applied to pickup: it used to be, and with the default now
  4000 that would refuse every walk-in buying one coffee.
- **`deliveryRadiusKm` is nullable and null means no limit. The owner's limit
  is 25 km** (2026-09-04) — the column default, backfilled onto branches that
  had NULL or 5. The previous migration had cleared the unenforced default of
  10 rather than newly refusing deliveries no owner had chosen to refuse; the
  owner has now named the number, so a branch starts at 25 km. Clearing the
  field is still a deliberate "we deliver anywhere", and the admin's branch
  wizard sends **null** for a blank field — never 0, which refuses everything.
- **The delivery price uplift is folded into the item price, not shown as a
  separate line** (owner decision — it reads as a second delivery fee
  otherwise). `BranchSetting.deliveryUpliftPercent` is the default;
  `Product.deliveryUpliftPercent` overrides it, where **null falls through and
  zero is a real choice** ("never uplift this item"). It is applied in
  `resolveCartLines` **before** the pricing engine sees the line, so it sits
  inside the VAT-inclusive price and is snapshotted like any other price —
  `VatService` remains the only place a payable amount is decided.
- **The branch menu returns both prices** (`priceMinor`, `deliveryPriceMinor`)
  so an app can switch between pickup and delivery without refetching **and
  never has to derive one from the other**, which would be a client computing a
  price.
- **The itemised breakdown is built once** (`src/vat/order-breakdown.ts`,
  pure) and snapshotted onto the order, so the customer summary, the branch view
  and the owner view show the same list. **Every row carries `included`** —
  prices are VAT-inclusive, so the VAT row does not add to the total and a
  client that summed every row would overstate every order by 15%.
  `assertBreakdownAddsUp` runs at placement: a list that does not reconstruct
  the amount charged is worse than no list.
- **A discount is a strikethrough on the row it applied to, never its own
  line** (owner decision, 2026-09-04). `strikethroughMinor` carries what the row
  would have cost. "~~60.00~~ 50.00" reads as a saving immediately; "Items 60.00
  / Discount −10.00" is arithmetic the customer has to do before they feel
  anything. The engine allocates item and delivery discounts separately, and
  this follows it — a "free delivery" coupon strikes the delivery row through
  and leaves the food alone. The rows then simply add up, with nothing to
  subtract.
- **Every fee we levy is a `Charge`** (name, `appliesTo`, fixed/percentage/
  per-item, taxable, per branch, conditions). A platform fee, a service fee or
  anything else the owner adds appears in the breakdown by its own name with no
  code change — which is why the breakdown lists charges generically instead of
  naming them.

Established in audit logging (the writer that did not exist):

- **The audit log had a read API and an empty table and no writer.** `GET
  /audit` (`audit:read`, owner-only) and the `AuditLog` schema had shipped since
  Phases 1–3, and several modules' comments claimed rows were "written by the
  correlation-id middleware" — **there was no such middleware and nothing ever
  wrote a row.** The read screen would have been empty for ever. Same
  built-and-inert shape as promotions and opening hours. The writer is now real;
  read `src/audit/README.md` before changing any of it.
- **The writer is `AuditRecorder.record()`** (`src/audit/`), injected by feature
  modules from `AuditModule`. It reads *who* (actor), *which request*
  (correlation id), IP and user-agent from a per-request `RequestContext`
  (`src/common/context/`, Node `AsyncLocalStorage`) — seeded by
  `RequestContextMiddleware` and completed by the auth guard's `setActor()` once
  the actor is resolved. So no service method grew a context argument. A public
  route (staff login) has no ambient actor yet and names it on the entry.
- **Best-effort and post-commit, like notifications/loyalty.** `record()` never
  throws and is called **after** the action's transaction commits, on the base
  client — an audit write can never roll back or break the action it records.
  The accepted cost: a crash between commit and audit-write leaves that action
  unrecorded. A gap-proof version needs a **transactional outbox** — named as
  deliberate follow-up in the README, not pretended.
- **The caller owns the before/after snapshot**, because only the caller knows
  what must *not* be written — the account-deletion rule (an audit row for an
  erasure must not re-store the erased PII) is exactly why middleware-style
  blind snapshotting was rejected. On top, `sanitizeSnapshot` (pure, tested)
  masks a sensitive-key denylist at any depth and serialises `Decimal`/`BigInt`
  via their string form, never by walking their internals.
- **Action strings live in `audit-actions.ts`** (`AUDIT_ACTIONS`) — never inline
  a bare string; a typo is invisible until someone filters for the right one and
  finds nothing.
- **First tranche wired** (the actions with no other record): staff
  login/login-failed; staff create/update/password-reset/role-assign/role-revoke;
  branch create/update/status-change/delete/duplicate/settings-update; refund
  request approve/reject and refund issued (decision and payout are separate
  rows, on purpose). **Deliberately not yet wired:** menu/price changes,
  coupon/promotion changes, customer account deletion, settlement ingestion, and
  order status transitions (already covered by `OrderStatusHistory`). Extend by
  importing `AuditModule`, injecting `AuditRecorder`, recording post-commit, and
  adding to `AUDIT_ACTIONS` in the same commit. **This supersedes the earlier
  "nothing writes AuditLog yet" notes** below (account deletion, refund requests,
  delivery, driver contact): the convention is now set — follow it there when
  those actions are wired, rather than inventing a second one.

Full table in `README.md`. Detail in `ARCHITECTURE.md`. Security rules in
`SECURITY.md`.

---

## Blocked on business input

Needed before the phases that depend on them — **must not be guessed**:

- VAT treatment of delivery fees, and discount ordering vs. VAT → (7)
- A routing provider, if straight-line × 1.3 is not accurate enough for fees
- Tap merchant account, credentials, Apple Pay/mada eligibility → (11)
- Refund policy → (12). **Answered by the owner, 2026-09-07 and 2026-09-08.**
  10 minutes from placement to ask to cancel, 10 minutes from delivery to ask
  for a refund, a reason required on both; a **paid** order cannot be cancelled
  by the customer at all, only requested; the **branch** decides a request; the
  **owner** issues the money from the Tap dashboard and records it. Nothing here
  is a placeholder any more — change these because the owner changed their mind,
  not because they look unfinished.
- Branch list, menu and prices, delivery zones and fees → (5, 6)
- SMS/OTP, maps and push providers → (4, 14, 16)
- POS and printer hardware — inspect the actual devices → (15)
- **How many drops one driver should carry at once** —
  `DRIVER_MAX_ACTIVE_DELIVERIES` defaults to 3 as a safety ceiling, not as an
  answer. It depends on the vehicle, the bag and the distances → (14)
- **A driver pay/commission model** — the driver app deliberately shows no
  earnings figure because there is nothing in this backend to compute one
  from → (14)

Credentials come through secure secret management, never through GitHub, chat
or a file in this repository.

---

## Working agreements

- Work in small phases. Run tests after each.
- Inspect before coding; explain architectural changes and risks first.
- Do not silently change frameworks or dependencies.
- Do not fabricate external API behaviour.
- Do not claim a TODO is complete.
- Prefer the modular monolith. Do not split payments, VAT, coupons or loyalty
  into separate services or repositories without an explicit scaling decision.
