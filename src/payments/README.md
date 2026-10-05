# `payments/`

**Status: implemented (mock gateway) — Phase 11. Real Tap adapter: stubbed,
pending official docs + credentials.**

Online payment orchestration, sitting between the order engine and a payment
gateway. It never invents anything about a real provider: a gateway is one
adapter behind an interface, and the sandbox mock adapter lets the whole payment
flow be built and proven before Tap credentials exist.

## The money rules it enforces

From the specification (§10) and CLAUDE.md — code that breaks these does not
ship:

1. **Client-side success is never proof of payment.** `initiate` returns what
   the client must do next; it does not mark anything paid. Only a
   signature-verified webhook (or a server-initiated gateway check) advances a
   payment to PAID. Proven by `marks paid ... only on a verified success
   webhook` and `rejects and records an unverified webhook, and never acts on
   it`.
2. **Fulfilment and money stay separate.** A verified success sets
   `Order.paymentStatus = PAID` and, only if the order is still awaiting payment,
   confirms it through the order engine's single transition choke point
   (`OrdersService.applyTransition`). The money column is never derived from the
   fulfilment column or vice-versa.
3. **Every financial operation is idempotent.** A `PaymentAttempt` carries a
   unique `idempotencyKey`, so a double-tapped or retried initiate charges once.
   A `PaymentWebhookEvent` is unique per `(gatewayName, gatewayEventId)`, so a
   replayed webhook delivery is recorded once and acted on once.
4. **Secrets stay on the backend.** All gateway credentials live in the adapter,
   configured from the environment. Nothing gateway-secret is returned to a
   client or logged (the mock signature header is on the redaction list).

## The gateway interface

`gateway/payment-gateway.interface.ts` is the port. Its types are **neutral** —
they borrow no field names or event shapes from any real provider, because those
must come from official documentation, not guesswork. Each adapter translates
between this neutral shape and its gateway at its own boundary.

- **`MockPaymentGateway`** — a fully working sandbox gateway. It signs its own
  webhooks with HMAC-SHA256 over the raw body and verifies them the same way, so
  the backend's verification path is genuinely exercised rather than stubbed to
  "always valid". `buildWebhook()` and the `/webhooks/payments/mock/simulate`
  endpoint complete a sandbox charge by delivering a real signed event — the
  same path a real gateway would use.
- **`TapPaymentGateway`** — deliberately **unimplemented**. Every method throws a
  specific `ServiceUnavailableException`. It exists to hold Tap's place behind
  the interface and to fail loudly if a deployment selects `PAYMENT_GATEWAY=tap`
  before the adapter is built — far safer than a silent stub that pretends to
  take payments. Implementing it (endpoints, field mapping, signature scheme)
  requires current official Tap docs and merchant credentials, both blocked
  business inputs.

The adapter is chosen at boot from `PAYMENT_GATEWAY` and injected under the
`PAYMENT_GATEWAY` token, so nothing else in the module depends on a concrete
gateway.

## Configuration

| Var | Meaning |
| --- | --- |
| `PAYMENT_GATEWAY` | `mock` (default) or `tap`. |
| `PAYMENT_SANDBOX` | Sandbox rails + simulate endpoint. Must be false in production. |
| `PAYMENT_MOCK_WEBHOOK_SECRET` | HMAC secret the mock signs/verifies with (dev only). |

Real `TAP_*` credentials are documented in `.env.example` but consumed only once
the Tap adapter is implemented, and always via secret management.

## Endpoints

Customer (`/api/v1/customer/orders/:orderId`):

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/pay` | Start (or idempotently re-request) a charge. Returns the next client action. |
| GET | `/payment` | The payment status for my order. |

Webhooks (`/api/v1/webhooks/payments`, public — the signature is the boundary):

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/:gateway` | Receive a gateway webhook. Verified, then processed exactly once. |
| POST | `/:gateway/simulate` | Sandbox only: complete a mock charge with a real signed event. |

Staff (`/api/v1/payments`, `payments:read`, branch-isolated through the order):

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | List payments (filter by branch/status/order). |

## Order lifecycle wiring

- Online order placed (Phase 8) → `PENDING_PAYMENT`.
- Customer `POST /pay` → `Payment` (PENDING) + `PaymentAttempt` created, gateway
  charge started. Order unchanged.
- Gateway → signed webhook → verified → `Payment` PAID, `Order.paymentStatus`
  PAID, order `CONFIRMED` (system-attributed). A failure → `PAYMENT_FAILED`.

## Refunds

Refunds are Phase 12, in `../refunds/`. The gateway `refund()` call and the
neutral refund webhook event live in this module's interface/adapters; refund
*creation* and *event application* live in the refunds module. A refund webhook
(carrying `gatewayRefundId`) is dispatched from `handleWebhook` to
`RefundsService.applyRefundEvent`, so webhook ingestion stays in one place.

## Not yet here

- The real Tap adapter (blocked — official docs + credentials).
- Settlement/fee reconciliation — Phase 18 (`gatewayFeeMinor` is captured now).
- A pull-side reconciliation job using `retrieveCharge` for missed webhooks —
  the interface method exists; wiring a scheduled reconcile is a later refinement.

## Tests

- `test/unit/mock-payment.gateway.spec.ts` — signing, tamper/secret/missing
  rejection, parsing.
- `test/unit/tap-payment.gateway.spec.ts` — the stub refuses loudly.
- `test/integration/payments.spec.ts` — initiate without paying, idempotent
  initiate, COD refusal, verified success/failure advancing the order, replayed
  webhook processed once, unverified webhook rejected and recorded, unknown
  gateway rejected — against a real database.
