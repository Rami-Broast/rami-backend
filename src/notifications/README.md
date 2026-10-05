# `notifications/`

**Status: implemented — Phase 16.** (The SMS port here also carries OTP delivery,
built in Phase 4.)

Customer notifications for order, payment and refund events, over provider
abstractions so vendors can be swapped without touching domain code (spec §20).

## Provider ports

- `sms/` — the outbound SMS port (`SMS_SENDER`) and a `MockSmsAdapter`. Also used
  by the auth OTP flow. It never logs a message body.
- `push/` — the outbound push port (`PUSH_SENDER`) and a `MockPushAdapter`.

Both are selected from configuration (`SMS_PROVIDER`, `PUSH_PROVIDER`, both
`mock` by default). No real SMS or push credential is invented — swapping in a
live provider is one new class implementing the port.

## Dispatch

`NotificationsService`:

- `onOrderStatus(orderId, status)` — fires the notification matching a fulfilment
  status change (confirmed, preparing, ready, driver assigned, out for delivery,
  delivered, cancelled), or nothing for states with no customer message.
- `onPaymentFailed(orderId)` / `onRefundUpdate(orderId)` — the money-side events.
- `dispatch(orderId, type)` — builds copy from the pure `notification-messages`
  catalog, writes a `Notification` with a per-channel `NotificationDelivery`
  (SMS + push), sends over both ports, and records `SENT`/`FAILED` per channel.

**Trigger calls are best-effort.** `dispatch` swallows and records failures — a
notification must never break the operation that caused it. Callers invoke these
**after** their own database work has committed, never inside a transaction:

- `OrdersService` — after placement (COD confirmation) and after every
  post-commit status transition, and on cancellation.
- `PaymentsService.handleWebhook` — after the webhook transaction commits:
  ORDER_CONFIRMED on a verified payment, PAYMENT_FAILED on a failure,
  REFUND_UPDATE on a refund event.

Nothing sensitive is ever templated or stored — no OTP, no payment credential.
The schema forbids an OTP in a notification body, and these are order updates.

## Endpoints

Customer (`/api/v1/customer/notifications`): `GET /` — my notification feed
(own only, by customer id).

## Not yet here

- Arabic/RTL copy — added to `notification-messages.ts` when the customer app
  localises (the structure is ready; English today).
- Device-token registration for push — the mock adapter addresses by customer
  id; a real adapter resolves tokens when a provider is contracted.
- Promotions (`PROMOTION` type) — a marketing send, out of scope for lifecycle
  notifications.

## Tests

- `test/unit/notification-messages.spec.ts` — copy and status→type mapping.
- `test/integration/notifications.spec.ts` — a COD order's confirmation and each
  advance produce one notification with two SENT deliveries; an online order is
  silent until paid, then notified; a failed payment notifies — real database.
