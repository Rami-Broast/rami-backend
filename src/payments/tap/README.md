# `payments/tap/`

**Status: not implemented — the Tap adapter is an explicit stub.**

Tap is the confirmed payment gateway (master spec §10), but **nothing about
Tap's API may be invented** — not an endpoint, a field name, or the webhook
signature scheme. Implementing the adapter requires:

- current official Tap API/SDK documentation, and
- real merchant credentials (sandbox and production, kept strictly separate).

Both are blocked business inputs (see CLAUDE.md § "Blocked on business input").

## What exists instead

The gateway interface and a fully working **mock** adapter are implemented in
`../gateway/` (Phase 11), so the entire platform payment flow — charge creation,
signed webhooks, signature verification, idempotent processing, order
advancement — is built and tested behind the interface.

The Tap adapter itself lives at `../gateway/tap-payment.gateway.ts` as a stub
whose every method throws a specific `ServiceUnavailableException`. Selecting
`PAYMENT_GATEWAY=tap` before it is built fails loudly rather than silently
pretending to take payments.

## When credentials and docs arrive

Only the bodies of `TapPaymentGateway`'s methods change — mapping the neutral
`PaymentGateway` types to Tap's real request/response and webhook shapes, and
verifying Tap's signature scheme. Nothing else in the platform changes, because
everything already depends on the interface, not on Tap.

This directory holds Tap-specific implementation detail (request builders,
response mappers, signature verification) once that work begins.
