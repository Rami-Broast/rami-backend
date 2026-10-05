import { DeliveryStatus } from '@prisma/client';

/**
 * The delivery state machine.
 *
 * A pure module, mirroring `orders/order-status.machine.ts` for the same
 * reason: the rules governing how a delivery may move are testable in
 * isolation and cannot drift between the places that call them.
 *
 * This machine is deliberately narrower than the order machine's cancellation
 * rule. The order machine (Phase 8, unchanged here) allows `CANCELLED` only up
 * to and including `DRIVER_ASSIGNED` — once an order is picked up, it is too
 * late to cancel. That means a delivery can only ever be cancelled from
 * `PENDING_ASSIGNMENT` or `ASSIGNED` (and only as a cascade of the order being
 * cancelled — see `OrdersService.cancelDeliveryRecord`). A delivery that goes
 * wrong *after* pickup has no order-level equivalent to fall back on, so it
 * has its own terminal state, `FAILED`, which intentionally does **not** move
 * the order — see `DeliveryService.markFailed` for why.
 *
 * ```
 * PENDING_ASSIGNMENT ─▶ ASSIGNED ─▶ PICKED_UP ─▶ OUT_FOR_DELIVERY ─▶ DELIVERED
 *        ▲          │       │            │               │
 *        └──────────┘       │            │               │
 *        (unassign)         │            │               │
 *        │                  │            │               │
 *        ▼                  ▼            ▼               ▼
 *   CANCELLED          CANCELLED      FAILED          FAILED
 * ```
 *
 * `ASSIGNED → PENDING_ASSIGNMENT` exists because a driver can stop being able
 * to do a job after taking it — shift ends, phone dies, wrong driver picked,
 * account deactivated. Without it a delivery could never move to anyone else:
 * the only way out was cancelling the customer's order, and a driver
 * deactivated mid-job stranded every delivery they held. Only legal *before*
 * pickup; once the food is in the car, moving it is a physical problem, not a
 * status one.
 */
const TRANSITIONS: Readonly<Record<DeliveryStatus, readonly DeliveryStatus[]>> = {
  [DeliveryStatus.PENDING_ASSIGNMENT]: [DeliveryStatus.ASSIGNED, DeliveryStatus.CANCELLED],
  [DeliveryStatus.ASSIGNED]: [
    DeliveryStatus.PICKED_UP,
    DeliveryStatus.PENDING_ASSIGNMENT,
    DeliveryStatus.CANCELLED,
  ],
  [DeliveryStatus.PICKED_UP]: [
    DeliveryStatus.OUT_FOR_DELIVERY,
    DeliveryStatus.DELIVERED,
    DeliveryStatus.FAILED,
  ],
  [DeliveryStatus.OUT_FOR_DELIVERY]: [DeliveryStatus.DELIVERED, DeliveryStatus.FAILED],
  // Terminal.
  [DeliveryStatus.DELIVERED]: [],
  [DeliveryStatus.FAILED]: [],
  [DeliveryStatus.CANCELLED]: [],
};

/** Statuses from which no further transition is possible. */
export function isDeliveryTerminal(status: DeliveryStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** Every status legal to move to from `from`. */
export function deliverySuccessorsOf(from: DeliveryStatus): readonly DeliveryStatus[] {
  return TRANSITIONS[from];
}

/** True when `from → to` is a legal delivery transition. */
export function canTransitionDelivery(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * The delivery timestamp column a transition into `status` should stamp, or
 * `null` when the status has none. `PENDING_ASSIGNMENT` has no dedicated
 * timestamp beyond `createdAt`, which already records when it opened.
 */
export function deliveryTimestampFieldFor(
  status: DeliveryStatus,
): 'assignedAt' | 'pickedUpAt' | 'deliveredAt' | 'cancelledAt' | 'failedAt' | null {
  switch (status) {
    case DeliveryStatus.ASSIGNED:
      return 'assignedAt';
    case DeliveryStatus.PICKED_UP:
      return 'pickedUpAt';
    case DeliveryStatus.DELIVERED:
      return 'deliveredAt';
    case DeliveryStatus.CANCELLED:
      return 'cancelledAt';
    case DeliveryStatus.FAILED:
      return 'failedAt';
    default:
      return null;
  }
}
