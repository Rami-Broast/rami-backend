# `src/` layout

Two kinds of directory live here.

## Implemented

| Directory | Contents |
| --- | --- |
| `config/` | Environment validation and the typed configuration tree. Nothing else reads `process.env`. |
| `logger/` | Structured Pino logging, correlation IDs, and the redaction list that keeps secrets out of logs. |
| `common/` | Cross-cutting HTTP concerns: the error envelope, error codes, the global exception filter, pagination DTOs. |
| `prisma/` | `PrismaService` — connection lifecycle and the readiness round-trip. |
| `health/` | Liveness and readiness probes. |
| `auth/` | OTP and password login, token rotation, actor resolution, and the global auth/permission guards. |
| `branches/` | Branch isolation: the access guard and the query-scoping helpers every branch-aware query must use. |
| `menu/` | The branch-aware catalog and server-side cart resolution. |
| `vat/` | The pricing/VAT engine — the only place a payable amount is decided. |
| `orders/` | The order engine: placement, the status machine, and the single transition choke point later modules drive fulfilment through. |
| `notifications/` | Customer notifications over SMS + push provider ports, each with a mock adapter. |
| `coupons/` | Coupon eligibility and atomic reuse prevention. |
| `loyalty/` | The points ledger — earn, reverse, adjust. |
| `payments/` | Gateway orchestration behind an interface (`MockPaymentGateway` working; `TapPaymentGateway` a stub), including webhook ingestion (`payments.webhook.controller.ts`) — `webhooks/` below stays a placeholder because this is where it actually lives. |
| `refunds/` | Full/partial refunds, never exceeding refundable, completed only by a verified webhook. |
| `drivers/` | Driver profiles: vehicle details, shift status, availability and live location. |
| `delivery/` | Delivery assignment and the driver-facing leg of fulfilment, kept in lockstep with `Order.status`. |
| `settlements/` | Reconciles gateway payouts against our payment/refund records; never derived from order totals. |
| `reports/` | Sales, VAT and payment reports over snapshotted data, branch-isolated. |

## Placeholders — later phases

Every other directory (`users/`, `customers/`, `payments/tap/`, `invoices/`,
`zatca/`, `webhooks/`, `audit/`) contains **only a `README.md`** describing its
scope, its phase, and the rules it must uphold.

They exist so the target structure is reviewable now. **None of them is
implemented.** A module is complete only when it is implemented, tested,
documented, and its failure cases are handled.

See [`../ARCHITECTURE.md`](../ARCHITECTURE.md) for how these fit together and
the phase order in which they land.
