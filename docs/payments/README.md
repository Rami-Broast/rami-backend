# Payments documentation

**Nothing is implemented yet — Tap integration is Phase 11.**

What belongs here once it is: the payment and refund state machines, webhook
verification and idempotency handling, the reconciliation runbook, and the
failure-mode playbook (gateway timeout, duplicate webhook, partial refund,
settlement mismatch).

Rules:

- Document only behaviour confirmed against **current official Tap
  documentation**. Never write down inferred gateway behaviour as fact.
- Never record credentials, keys or merchant identifiers here.
- Sandbox and production differences must be stated explicitly.
