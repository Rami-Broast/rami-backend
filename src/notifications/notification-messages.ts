import { NotificationType, OrderStatus } from '@prisma/client';

/**
 * Customer-facing notification copy, kept in one pure module so the wording is
 * testable and consistent, and so a new event type cannot be wired up without a
 * message. English today; Arabic/RTL copy is added here when the customer app
 * localises (spec confirms full Arabic support for the client apps).
 *
 * Nothing sensitive is ever templated here — no OTP, no payment credential. The
 * schema forbids storing an OTP in a notification body, and these are order
 * updates, not secrets.
 */

export interface OrderMessageContext {
  orderNumber: string;
  branchName?: string | null;
}

export interface RenderedMessage {
  title: string;
  body: string;
}

type MessageBuilder = (ctx: OrderMessageContext) => RenderedMessage;

const MESSAGES: Partial<Record<NotificationType, MessageBuilder>> = {
  [NotificationType.ORDER_RECEIVED]: (c) => ({
    title: 'Order received',
    body: `We’ve got order ${c.orderNumber}${
      c.branchName ? ` at ${c.branchName}` : ''
    }. You’ll hear from us the moment the branch confirms it.`,
  }),
  [NotificationType.ORDER_CONFIRMED]: (c) => ({
    title: 'Order confirmed',
    body: `Your order ${c.orderNumber} is confirmed and is being prepared shortly.`,
  }),
  [NotificationType.PAYMENT_FAILED]: (c) => ({
    title: 'Payment failed',
    body: `We couldn’t take payment for order ${c.orderNumber}. Please try again.`,
  }),
  [NotificationType.ORDER_PREPARING]: (c) => ({
    title: 'Preparing your order',
    body: `The kitchen has started preparing order ${c.orderNumber}.`,
  }),
  [NotificationType.ORDER_READY]: (c) => ({
    title: 'Order ready',
    body: `Order ${c.orderNumber} is ready.`,
  }),
  [NotificationType.DRIVER_ASSIGNED]: (c) => ({
    title: 'Driver assigned',
    body: `A driver has been assigned to order ${c.orderNumber}.`,
  }),
  [NotificationType.OUT_FOR_DELIVERY]: (c) => ({
    title: 'Out for delivery',
    body: `Order ${c.orderNumber} is on its way.`,
  }),
  [NotificationType.ORDER_DELIVERED]: (c) => ({
    title: 'Delivered',
    body: `Order ${c.orderNumber} has been delivered. Enjoy!`,
  }),
  [NotificationType.ORDER_CANCELLED]: (c) => ({
    title: 'Order cancelled',
    body: `Order ${c.orderNumber} has been cancelled.`,
  }),
  [NotificationType.REFUND_UPDATE]: (c) => ({
    title: 'Refund update',
    body: `There’s an update on the refund for order ${c.orderNumber}.`,
  }),
};

/**
 * Copy for the three moments in a refund request's life.
 *
 * These are rendered by the caller and passed to `dispatch` as an override
 * rather than keyed off `NotificationType`, because all three are
 * `REFUND_UPDATE` — the type says which feed a message belongs in, and
 * "we've got your request", "we're refunding you" and "we can't refund this"
 * are the same kind of update with three very different things to say. The
 * generic REFUND_UPDATE copy above still covers a gateway-driven refund that
 * nobody requested.
 *
 * The staff note is included verbatim on a rejection: a refusal a customer
 * cannot understand is a phone call to the branch.
 */
export function refundRequestReceivedMessage(ctx: OrderMessageContext): RenderedMessage {
  return {
    title: 'Request received',
    body: `We’ve got your request about order ${ctx.orderNumber}${
      ctx.branchName ? ` at ${ctx.branchName}` : ''
    }. The branch will look at it and you’ll hear back here.`,
  };
}

export function refundRequestApprovedMessage(
  ctx: OrderMessageContext,
  outcome: {
    outcome: 'AWAITING_PAYOUT' | 'MANUAL_SETTLEMENT' | 'CANCELLED_NO_REFUND';
    orderCancelled: boolean;
    note?: string | null;
  },
): RenderedMessage {
  // Approving is not paying: the branch decides and the owner then issues the
  // refund in the gateway's dashboard. So this message must never say the money
  // is on its way — a customer told that, who then checks their statement,
  // rings the branch. `refundIssuedMessage` is what says it, when it is true.
  const what =
    outcome.outcome === 'AWAITING_PAYOUT'
      ? 'Your refund is being arranged and you’ll hear from us again once it’s been sent.'
      : outcome.outcome === 'MANUAL_SETTLEMENT'
        ? 'The branch will settle this with you directly.'
        : outcome.orderCancelled
          ? 'The order has been cancelled.'
          : 'The branch will be in touch.';

  return {
    title: 'Request approved',
    body: `Your request about order ${ctx.orderNumber} was approved. ${what}${
      outcome.note ? ` ${outcome.note}` : ''
    }`,
  };
}

/**
 * The money has actually been sent. Separate from the approval above because
 * they are separate events, often hours apart, and telling someone their refund
 * has been sent when it has only been agreed is the one thing this whole flow
 * exists to stop.
 */
export function refundIssuedMessage(
  ctx: OrderMessageContext,
  amountMinor: number,
): RenderedMessage {
  const amount = (amountMinor / 100).toFixed(2);
  return {
    title: 'Refund sent',
    body: `We’ve sent your refund of SAR ${amount} for order ${ctx.orderNumber}. It can take a few days to appear on your statement.`,
  };
}

export function refundRequestRejectedMessage(
  ctx: OrderMessageContext,
  note: string,
): RenderedMessage {
  return {
    title: 'Request declined',
    body: `The branch couldn’t approve your request about order ${ctx.orderNumber}. ${note}`,
  };
}

/** Renders the copy for a type, or null when that type has no customer message. */
export function renderMessage(
  type: NotificationType,
  ctx: OrderMessageContext,
): RenderedMessage | null {
  const builder = MESSAGES[type];
  return builder ? builder(ctx) : null;
}

/**
 * Maps a fulfilment status to the customer notification it should trigger, or
 * null for statuses that carry no customer-facing message.
 *
 * PENDING_PAYMENT stays null deliberately: telling someone their order is
 * placed before the money has cleared is a message we may have to take back.
 * PICKED_UP is null because OUT_FOR_DELIVERY says the same thing to a customer
 * a moment later, and the refund states are covered by REFUND_UPDATE.
 */
export function notificationTypeForStatus(status: OrderStatus): NotificationType | null {
  switch (status) {
    // A manual-accept branch parks a paid or COD order here. It used to map to
    // null, so the customer was told nothing at all between paying and the
    // branch getting round to accepting — the one moment they most want to
    // know their order exists.
    case OrderStatus.AWAITING_ACCEPTANCE:
      return NotificationType.ORDER_RECEIVED;
    case OrderStatus.CONFIRMED:
      return NotificationType.ORDER_CONFIRMED;
    case OrderStatus.PREPARING:
      return NotificationType.ORDER_PREPARING;
    case OrderStatus.READY:
      return NotificationType.ORDER_READY;
    case OrderStatus.DRIVER_ASSIGNED:
      return NotificationType.DRIVER_ASSIGNED;
    case OrderStatus.OUT_FOR_DELIVERY:
      return NotificationType.OUT_FOR_DELIVERY;
    case OrderStatus.DELIVERED:
      return NotificationType.ORDER_DELIVERED;
    case OrderStatus.CANCELLED:
      return NotificationType.ORDER_CANCELLED;
    case OrderStatus.PAYMENT_FAILED:
      return NotificationType.PAYMENT_FAILED;
    default:
      return null;
  }
}
