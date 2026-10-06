import { OrderStatus, PaymentStatus, RefundRequestType } from '@prisma/client';

import { isCustomerCancellable } from '../orders/order-status.machine';
import { hasCapturedMoney } from '../payments/captured-money';

/**
 * Whether a customer may raise a refund/cancellation request against one of
 * their orders — and if not, why not, in a form the app can act on.
 *
 * Pure, so the rule can be tested at every point of an order's life rather than
 * only where a fixture happened to leave one. Kept beside the refund module
 * because it is a refund-policy question, not a fulfilment one.
 */

/** Why a request cannot be raised. Each is a different thing for a client to say. */
export type RefundRequestBlocker =
  /**
   * The customer can still cancel the order themselves. A request here would be
   * a slower path to the same outcome, waiting on a human for something the
   * order engine will do immediately.
   */
  | 'SELF_SERVICE_CANCEL'
  /** They have already asked and nobody has decided yet. */
  | 'ALREADY_OPEN'
  /** A refund is already on its way to them. */
  | 'REFUND_IN_PROGRESS'
  /** Nothing was ever captured, or everything captured has already gone back. */
  | 'NOTHING_TO_REFUND'
  /** Past the window the owner set. Only ever returned when one is set. */
  | 'WINDOW_CLOSED';

export interface RefundRequestOrderFacts {
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  /** When the order was placed. The cancellation window runs from here. */
  placedAt: Date;
  deliveredAt: Date | null;
  cancelledAt: Date | null;
  /** True when this order already has a PENDING request. */
  hasOpenRequest: boolean;
}

/**
 * The owner's two windows, which are different questions with different clocks.
 *
 * **Cancellation** is "I have changed my mind", and it runs from the moment the
 * order was placed — the branch has bought ingredients and started cooking, and
 * the cost of a late change lands on them.
 *
 * **Refund** is "something was wrong with what arrived", which cannot be known
 * until it arrives, so it runs from delivery instead.
 *
 * The owner's answer is **10 minutes for both** (2026-09-08). Both are config
 * rather than constants, like the VAT rate: the day 10 becomes 15 should not be
 * a deploy of changed logic. Null on either means no deadline at all.
 */
export interface RefundWindows {
  /** Minutes from placement to ask for a cancellation. Null = no deadline. */
  cancellationMinutes: number | null;
  /** Minutes from delivery to ask for a refund. Null = no deadline. */
  refundMinutes: number | null;
}

export interface RefundRequestEligibility {
  /** True when `POST /customer/orders/:id/refund-request` would be accepted. */
  canRequest: boolean;
  /**
   * What a request would be. Present even when `canRequest` is false and the
   * blocker is `SELF_SERVICE_CANCEL`, so a client can label the button.
   */
  type: RefundRequestType | null;
  /** True when the customer can cancel the order outright, with no request. */
  canSelfCancel: boolean;
  blocker: RefundRequestBlocker | null;
  /** Customer-facing sentence explaining the state. Always present. */
  message: string;
  /**
   * When the applicable window shuts, or null when there is none. A client can
   * count down against it — "8 minutes left to cancel" is the difference
   * between a deadline someone can act on and one they only meet by missing it.
   */
  windowClosesAt: Date | null;
}

/** Statuses that mean the order is over, one way or the other. */
function isFinished(status: OrderStatus): boolean {
  return (
    status === OrderStatus.DELIVERED ||
    status === OrderStatus.CANCELLED ||
    status === OrderStatus.REFUNDED ||
    status === OrderStatus.PARTIALLY_REFUNDED
  );
}

function plusMinutes(from: Date, minutes: number): Date {
  return new Date(from.getTime() + minutes * 60 * 1000);
}

/**
 * Decides eligibility against the owner's windows.
 *
 * Note what is deliberately *not* windowed: the order engine's own
 * self-cancel rule. A customer whose order is still `PENDING_PAYMENT` /
 * `AWAITING_ACCEPTANCE` / `CONFIRMED` can cancel it outright however long ago
 * they placed it, because nothing has been cooked and the cancellation costs
 * the branch nothing. The window is on the *ask* — the thing that takes a
 * branch manager's time and gives money back.
 */
export function refundRequestEligibility(
  order: RefundRequestOrderFacts,
  now: Date,
  windows: RefundWindows,
): RefundRequestEligibility {
  const finished = isFinished(order.status);

  // An order already with the customer is a refund question; one still on its
  // way is a cancellation question. The customer is never asked to tell them
  // apart — that would be asking them to know our fulfilment model.
  const type = finished ? RefundRequestType.REFUND : RefundRequestType.CANCELLATION;

  // Two clocks, because they answer two different questions. The refund clock
  // only starts when the order ends — refusing to cancel an order that has not
  // arrived because it "arrived too long ago" would be nonsense.
  const finishedAt = order.deliveredAt ?? order.cancelledAt ?? null;
  const windowClosesAt =
    type === RefundRequestType.CANCELLATION
      ? windows.cancellationMinutes !== null
        ? plusMinutes(order.placedAt, windows.cancellationMinutes)
        : null
      : windows.refundMinutes !== null && finishedAt
        ? plusMinutes(finishedAt, windows.refundMinutes)
        : null;

  const base = { canSelfCancel: false, windowClosesAt };
  const paid = hasCapturedMoney(order.paymentStatus);

  // **Money is the gate on cancelling yourself, not time** (owner decision,
  // 2026-09-08). Nothing has been taken for an unpaid order — a cash order the
  // kitchen has not started, or one still waiting on a card — so cancelling it
  // costs the branch nothing and needs nobody's approval. The moment money has
  // been captured that stops being true: cancelling now means giving money
  // back, and giving money back is the branch's decision. So a paid order falls
  // through to the request path below however early it is.
  if (isCustomerCancellable(order.status) && !paid) {
    return {
      ...base,
      canSelfCancel: true,
      canRequest: false,
      type: RefundRequestType.CANCELLATION,
      blocker: 'SELF_SERVICE_CANCEL',
      message: 'You can cancel this order yourself right now.',
      // Nothing is counting down against a customer who can simply cancel.
      windowClosesAt: null,
    };
  }

  if (order.hasOpenRequest) {
    return {
      ...base,
      canRequest: false,
      type: null,
      blocker: 'ALREADY_OPEN',
      message: 'You’ve already asked about this order. The branch is looking at it.',
    };
  }

  if (order.paymentStatus === PaymentStatus.REFUND_PENDING) {
    return {
      ...base,
      canRequest: false,
      type: null,
      blocker: 'REFUND_IN_PROGRESS',
      message: 'A refund for this order is already being sorted out.',
    };
  }

  // Money only has to have been taken for a *refund*. A cancellation can be
  // worth asking for on a cash-on-delivery order where nothing has been paid at
  // all — stopping the food is the whole point of the request.
  if (type === RefundRequestType.REFUND && !hasCapturedMoney(order.paymentStatus)) {
    return {
      ...base,
      canRequest: false,
      type: null,
      blocker: 'NOTHING_TO_REFUND',
      message:
        order.paymentStatus === PaymentStatus.REFUNDED
          ? 'This order has already been fully refunded.'
          : 'There’s nothing left to refund on this order.',
    };
  }

  if (windowClosesAt && now.getTime() > windowClosesAt.getTime()) {
    return {
      ...base,
      canRequest: false,
      // Kept populated here, unlike the other blockers: *which* window was
      // missed is the whole content of this refusal — a cancellation window and
      // a refund window are different promises on different clocks — and it is
      // what the miss is recorded against so the policy can be measured later.
      type,
      blocker: 'WINDOW_CLOSED',
      message:
        type === RefundRequestType.CANCELLATION
          ? 'It’s too late to cancel this one online — the kitchen is already on it. Please call the branch.'
          : 'The window for requesting a refund on this order has closed.',
    };
  }

  return {
    ...base,
    canRequest: true,
    type,
    blocker: null,
    message:
      type === RefundRequestType.REFUND
        ? 'Tell us what went wrong and the branch will look at a refund.'
        : paid
          ? // Says the real reason. "The kitchen has started" would be a guess,
            // and often a wrong one — a paid order seconds old is here too.
            'You’ve paid for this order, so the branch has to approve cancelling it and returning your money.'
          : 'The kitchen has already started this order, so the branch has to approve a cancellation.',
  };
}
