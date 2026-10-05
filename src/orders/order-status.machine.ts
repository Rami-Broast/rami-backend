import { OrderStatus, OrderType } from '@prisma/client';

/**
 * The order fulfilment state machine.
 *
 * This is a pure module — no database, no framework — so the rules that govern
 * how an order may move are testable in isolation and cannot drift between the
 * places that call them. `OrderStatus` is fulfilment only; money lives on
 * `Order.paymentStatus` and is never derived from the state here.
 *
 * The transition table is intentionally the single source of truth. A caller
 * asks {@link canTransition} rather than hard-coding "if PREPARING then READY"
 * in a service, so a new rule is added in one place and every path obeys it.
 *
 * ## The lifecycle
 *
 * ```
 * PENDING_PAYMENT ─▶ CONFIRMED ─▶ PREPARING ─▶ READY ─┬▶ (pickup)   DELIVERED
 *                                                     └▶ (delivery) DRIVER_ASSIGNED
 *                                                          ─▶ PICKED_UP
 *                                                          ─▶ OUT_FOR_DELIVERY
 *                                                          ─▶ DELIVERED
 * ```
 *
 * Alternative and terminal states — `PAYMENT_FAILED`, `CANCELLED`,
 * `REFUND_PENDING`, `REFUNDED`, `PARTIALLY_REFUNDED` — hang off the happy path.
 * The refund states are reached and advanced by the refunds module (Phase 12);
 * they live in this table so that module never has to redefine the rules.
 */

/**
 * Allowed successor states for every status. A status whose array is empty is
 * terminal. The table is deliberately type-agnostic: whether a `READY` order
 * goes to `DRIVER_ASSIGNED` or straight to `DELIVERED` depends on the order
 * type, and that narrowing is applied by {@link allowedNextStatuses}, not baked
 * into the table.
 */
const TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  [OrderStatus.PENDING_PAYMENT]: [
    OrderStatus.CONFIRMED,
    OrderStatus.AWAITING_ACCEPTANCE,
    OrderStatus.PAYMENT_FAILED,
    OrderStatus.CANCELLED,
  ],
  // A branch with autoAcceptOrders=false sees paid or COD orders arrive here.
  // Accept promotes to CONFIRMED, reject to CANCELLED with a required reason.
  [OrderStatus.AWAITING_ACCEPTANCE]: [OrderStatus.CONFIRMED, OrderStatus.CANCELLED],
  [OrderStatus.CONFIRMED]: [OrderStatus.PREPARING, OrderStatus.CANCELLED],
  [OrderStatus.PREPARING]: [OrderStatus.READY, OrderStatus.CANCELLED],
  [OrderStatus.READY]: [
    // Delivery orders hand off to a driver; pickup orders are collected. Both
    // successors are legal here; the order type decides which is offered.
    OrderStatus.DRIVER_ASSIGNED,
    OrderStatus.DELIVERED,
    OrderStatus.CANCELLED,
  ],
  [OrderStatus.DRIVER_ASSIGNED]: [
    OrderStatus.PICKED_UP,
    // Back to READY when the delivery is taken off its driver — shift ended,
    // phone died, wrong driver picked. The order has not changed; only who is
    // carrying it has, and it belongs in the pool again exactly as it was
    // before assignment. Without this edge a driver who stopped being able to
    // finish stranded the delivery, and cancelling the customer's order was
    // the only way out. Legal only before pickup; `DeliveryService` enforces
    // that end of it.
    OrderStatus.READY,
    OrderStatus.CANCELLED,
  ],
  [OrderStatus.PICKED_UP]: [OrderStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERED],
  [OrderStatus.OUT_FOR_DELIVERY]: [OrderStatus.DELIVERED],
  // A delivered order can only leave the happy path by being refunded.
  [OrderStatus.DELIVERED]: [OrderStatus.REFUND_PENDING],
  // Terminal.
  [OrderStatus.PAYMENT_FAILED]: [],
  [OrderStatus.CANCELLED]: [],
  // Refund lifecycle (Phase 12 drives these).
  [OrderStatus.REFUND_PENDING]: [
    OrderStatus.REFUNDED,
    OrderStatus.PARTIALLY_REFUNDED,
    // A failed refund returns the order to its delivered resting state.
    OrderStatus.DELIVERED,
  ],
  [OrderStatus.PARTIALLY_REFUNDED]: [OrderStatus.REFUND_PENDING],
  [OrderStatus.REFUNDED]: [],
};

/**
 * Statuses a customer may reach with kitchen/queue transitions, keyed by order
 * type. Applied on top of {@link TRANSITIONS} so that, for example, a pickup
 * order can never be routed to a driver and a delivery order is never marked
 * collected without going out for delivery.
 */
const TYPE_FORBIDDEN: Readonly<Record<OrderType, readonly OrderStatus[]>> = {
  // A pickup order has no driver leg.
  [OrderType.PICKUP]: [
    OrderStatus.DRIVER_ASSIGNED,
    OrderStatus.PICKED_UP,
    OrderStatus.OUT_FOR_DELIVERY,
  ],
  // A delivery order is never "collected" straight from READY; it is delivered
  // only at the end of the driver leg.
  [OrderType.DELIVERY]: [],
};

/** Statuses from which no further transition is possible. */
export function isTerminal(status: OrderStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** Every status legal to move to from `from`, ignoring order type. */
export function successorsOf(from: OrderStatus): readonly OrderStatus[] {
  return TRANSITIONS[from];
}

/**
 * The statuses reachable from `from` for an order of `type`.
 *
 * This is the type-aware view a caller should use: it removes successors that
 * do not apply to the order's fulfilment channel.
 */
export function allowedNextStatuses(from: OrderStatus, type: OrderType): readonly OrderStatus[] {
  const forbidden = new Set(TYPE_FORBIDDEN[type]);

  // A delivery order reaching DELIVERED must have gone through the driver leg,
  // so DELIVERED is not offered directly from READY for delivery orders.
  const extraForbidden =
    type === OrderType.DELIVERY && from === OrderStatus.READY
      ? new Set([OrderStatus.DELIVERED])
      : new Set<OrderStatus>();

  return TRANSITIONS[from].filter(
    (status) => !forbidden.has(status) && !extraForbidden.has(status),
  );
}

/** True when `from → to` is a legal transition for an order of `type`. */
export function canTransition(from: OrderStatus, to: OrderStatus, type: OrderType): boolean {
  return allowedNextStatuses(from, type).includes(to);
}

/**
 * Statuses a customer is permitted to cancel from themselves.
 *
 * Deliberately tighter than what staff may cancel: once the kitchen has started
 * preparing, only staff (with `orders:cancel`) may cancel, because food may
 * already have been made. A customer can still call, and staff decide.
 */
const CUSTOMER_CANCELLABLE: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.AWAITING_ACCEPTANCE,
  OrderStatus.CONFIRMED,
]);

export function isCustomerCancellable(status: OrderStatus): boolean {
  return CUSTOMER_CANCELLABLE.has(status);
}

/**
 * The order timestamp column that a transition into `status` should stamp, or
 * `null` when the status has no dedicated timestamp. Keeping this beside the
 * transition table means a new status cannot be wired up while forgetting to
 * record when it happened.
 */
export function timestampFieldFor(
  status: OrderStatus,
): 'confirmedAt' | 'preparingAt' | 'readyAt' | 'deliveredAt' | 'cancelledAt' | null {
  switch (status) {
    case OrderStatus.CONFIRMED:
      return 'confirmedAt';
    case OrderStatus.PREPARING:
      return 'preparingAt';
    case OrderStatus.READY:
      return 'readyAt';
    case OrderStatus.DELIVERED:
      return 'deliveredAt';
    case OrderStatus.CANCELLED:
      return 'cancelledAt';
    default:
      return null;
  }
}
