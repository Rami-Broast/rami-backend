-- "We have your order" — the message a manual-accept branch's customers never got.
--
-- An order placed at a branch with autoAcceptOrders=false lands in
-- AWAITING_ACCEPTANCE, and `notificationTypeForStatus` had no type for that
-- status, so `dispatch` returned early and nothing was written: no SMS, and
-- nothing in the app's notification feed. The customer had paid and heard
-- nothing until a staff member happened to accept.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ORDER_RECEIVED';
