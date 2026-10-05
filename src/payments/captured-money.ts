import { PaymentStatus } from '@prisma/client';

/**
 * Payment states in which money has actually been taken and not yet fully
 * returned — the states from which something *could* be given back.
 *
 * One definition, because two would drift. It decides two different things that
 * must agree: whether a customer may still cancel their own order (they may
 * not, once money has been captured — see `OrdersService.cancelByCustomer`),
 * and whether a refund request has anything to refund
 * (`refundRequestEligibility`). If those two ever disagreed, an app would offer
 * a cancel the server refuses, or a refund with nothing behind it.
 *
 * Pure and dependency-free on purpose: it is imported by both the order engine
 * and the refunds module without either taking a module dependency on the other.
 */
const CAPTURED: ReadonlySet<PaymentStatus> = new Set([
  PaymentStatus.PAID,
  PaymentStatus.PARTIALLY_REFUNDED,
]);

export function hasCapturedMoney(status: PaymentStatus): boolean {
  return CAPTURED.has(status);
}
