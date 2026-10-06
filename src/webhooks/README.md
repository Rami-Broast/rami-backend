# `webhooks/`

**Status: implemented in Phase 11 — lives in `../payments/`, not here.**

Inbound gateway webhook handling. Rather than a standalone module, webhook
ingestion is owned by the payments module, because verifying and processing a
payment webhook is inseparable from the payment and order state it advances.

See:

- `../payments/payments.webhook.controller.ts` — the public `POST
  /webhooks/payments/:gateway` endpoint. Public because a gateway is not an
  authenticated user; the security boundary is the signature over the raw body.
- `../payments/payments.service.ts` — `handleWebhook`: signature verification,
  idempotent persistence of `PaymentWebhookEvent` (unique per `(gatewayName,
  gatewayEventId)`), and advancement of the payment and order.
- `../payments/gateway/` — the gateway interface and adapters that sign and
  verify.

The guarantees the master specification asks of this area — server-side
signature verification before trust, idempotent processing, raw payloads
persisted for reconciliation with sensitive fields redacted from logs — are all
implemented and tested there (`test/integration/payments.spec.ts`).

A future non-payment webhook source (e.g. an SMS delivery receipt) could grow a
dedicated module here; today there is none.
