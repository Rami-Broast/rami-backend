import { OrderStatus, PaymentStatus, RefundRequestType } from '@prisma/client';

import {
  RefundRequestOrderFacts,
  RefundWindows,
  refundRequestEligibility,
} from '../../src/refunds/refund-request-eligibility';

const NOW = new Date('2026-09-07T12:00:00.000Z');

/** The owner's confirmed policy (2026-09-08): 10 minutes for both. */
const OWNER_WINDOWS: RefundWindows = { cancellationMinutes: 10, refundMinutes: 10 };
const NO_WINDOWS: RefundWindows = { cancellationMinutes: null, refundMinutes: null };

function minutesBefore(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60 * 1000);
}

function order(overrides: Partial<RefundRequestOrderFacts> = {}): RefundRequestOrderFacts {
  return {
    status: OrderStatus.PREPARING,
    paymentStatus: PaymentStatus.PAID,
    placedAt: minutesBefore(2),
    deliveredAt: null,
    cancelledAt: null,
    hasOpenRequest: false,
    ...overrides,
  };
}

describe('refundRequestEligibility', () => {
  describe('cancelling it yourself: money is the gate, not time', () => {
    it.each([OrderStatus.PENDING_PAYMENT, OrderStatus.AWAITING_ACCEPTANCE, OrderStatus.CONFIRMED])(
      'lets an unpaid %s be cancelled outright, with no queue and no clock',
      (status) => {
        // Nothing has been taken, so dropping the order costs the branch
        // nothing and needs nobody's approval.
        const result = refundRequestEligibility(
          order({ status, paymentStatus: PaymentStatus.PENDING, placedAt: minutesBefore(120) }),
          NOW,
          OWNER_WINDOWS,
        );

        expect(result.canSelfCancel).toBe(true);
        expect(result.canRequest).toBe(false);
        expect(result.blocker).toBe('SELF_SERVICE_CANCEL');
        expect(result.type).toBe(RefundRequestType.CANCELLATION);
        // Not on a clock: the window is on the *ask*, and there is no ask here.
        expect(result.windowClosesAt).toBeNull();
      },
    );

    it.each([OrderStatus.AWAITING_ACCEPTANCE, OrderStatus.CONFIRMED])(
      'refuses to let a paid %s be cancelled outright, however early',
      (status) => {
        // Owner decision: once money is captured, cancelling means giving it
        // back, and that is the branch's call — not the customer's.
        const result = refundRequestEligibility(
          order({ status, paymentStatus: PaymentStatus.PAID, placedAt: minutesBefore(1) }),
          NOW,
          OWNER_WINDOWS,
        );

        expect(result.canSelfCancel).toBe(false);
        expect(result.canRequest).toBe(true);
        expect(result.type).toBe(RefundRequestType.CANCELLATION);
      },
    );

    it('tells a paid customer the real reason they cannot just cancel', () => {
      // "The kitchen has already started" would be a guess, and wrong for an
      // order seconds old that nobody has touched.
      const result = refundRequestEligibility(
        order({
          status: OrderStatus.CONFIRMED,
          paymentStatus: PaymentStatus.PAID,
          placedAt: minutesBefore(1),
        }),
        NOW,
        OWNER_WINDOWS,
      );

      expect(result.message).toMatch(/paid/i);
      expect(result.message).not.toMatch(/kitchen/i);
    });

    it('still counts a partly refunded order as paid', () => {
      const result = refundRequestEligibility(
        order({
          status: OrderStatus.CONFIRMED,
          paymentStatus: PaymentStatus.PARTIALLY_REFUNDED,
          placedAt: minutesBefore(1),
        }),
        NOW,
        OWNER_WINDOWS,
      );

      expect(result.canSelfCancel).toBe(false);
    });
  });

  describe('the 10-minute cancellation window', () => {
    it('lets a customer ask inside it', () => {
      const result = refundRequestEligibility(
        order({ status: OrderStatus.PREPARING, placedAt: minutesBefore(9) }),
        NOW,
        OWNER_WINDOWS,
      );

      expect(result.canRequest).toBe(true);
      expect(result.type).toBe(RefundRequestType.CANCELLATION);
      expect(result.windowClosesAt).toEqual(new Date('2026-09-07T12:01:00.000Z'));
    });

    it('closes it once ten minutes have passed since placement', () => {
      const result = refundRequestEligibility(
        order({ status: OrderStatus.PREPARING, placedAt: minutesBefore(11) }),
        NOW,
        OWNER_WINDOWS,
      );

      expect(result.canRequest).toBe(false);
      expect(result.blocker).toBe('WINDOW_CLOSED');
      // The refusal has to name a next step, or it is a dead end on a screen.
      expect(result.message).toMatch(/call the branch/i);
    });

    it('runs from placement, not from anything that happened since', () => {
      // Measuring from the kitchen accepting would give a slow branch's
      // customers longer to cancel than a fast one's, which is backwards.
      const result = refundRequestEligibility(
        order({ status: OrderStatus.READY, placedAt: minutesBefore(30) }),
        NOW,
        OWNER_WINDOWS,
      );

      expect(result.blocker).toBe('WINDOW_CLOSED');
    });

    it('has no deadline at all when the owner sets none', () => {
      const result = refundRequestEligibility(
        order({ status: OrderStatus.PREPARING, placedAt: minutesBefore(500) }),
        NOW,
        NO_WINDOWS,
      );

      expect(result.canRequest).toBe(true);
      expect(result.windowClosesAt).toBeNull();
    });
  });

  describe('the refund window', () => {
    const delivered = order({
      status: OrderStatus.DELIVERED,
      placedAt: minutesBefore(200),
      deliveredAt: minutesBefore(120),
    });

    it('is a different clock from the cancellation window', () => {
      // Placed 200 minutes ago — far outside the cancellation window — but
      // delivered 2 minutes ago. A refund is "something was wrong with what
      // arrived", which cannot be known until it arrives, so the placement
      // clock must not close it.
      const justDelivered = order({
        status: OrderStatus.DELIVERED,
        placedAt: minutesBefore(200),
        deliveredAt: minutesBefore(2),
      });

      const result = refundRequestEligibility(justDelivered, NOW, OWNER_WINDOWS);

      expect(result.canRequest).toBe(true);
      expect(result.type).toBe(RefundRequestType.REFUND);
    });

    it('closes ten minutes after delivery', () => {
      // Owner decision: 10 minutes, measured from the food arriving.
      const result = refundRequestEligibility(delivered, NOW, OWNER_WINDOWS);

      expect(result.canRequest).toBe(false);
      expect(result.blocker).toBe('WINDOW_CLOSED');
    });

    it('stays open inside it', () => {
      const justDelivered = order({
        status: OrderStatus.DELIVERED,
        placedAt: minutesBefore(60),
        deliveredAt: minutesBefore(9),
      });

      const result = refundRequestEligibility(justDelivered, NOW, OWNER_WINDOWS);

      expect(result.canRequest).toBe(true);
      expect(result.windowClosesAt).toEqual(new Date('2026-09-07T12:01:00.000Z'));
    });

    it('never starts on an order that has not finished', () => {
      const result = refundRequestEligibility(
        order({ status: OrderStatus.PREPARING, placedAt: minutesBefore(1) }),
        NOW,
        { cancellationMinutes: null, refundMinutes: 10 },
      );

      expect(result.canRequest).toBe(true);
      expect(result.windowClosesAt).toBeNull();
    });
  });

  it('allows a cancellation request on an unpaid cash-on-delivery order', () => {
    // Nothing has been captured, so there is nothing to refund — but stopping
    // the food is the whole point of the request.
    const result = refundRequestEligibility(
      order({ status: OrderStatus.PREPARING, paymentStatus: PaymentStatus.PENDING }),
      NOW,
      OWNER_WINDOWS,
    );

    expect(result.canRequest).toBe(true);
    expect(result.type).toBe(RefundRequestType.CANCELLATION);
  });

  it('refuses a refund request when nothing was ever captured', () => {
    const result = refundRequestEligibility(
      order({
        status: OrderStatus.CANCELLED,
        paymentStatus: PaymentStatus.PENDING,
        cancelledAt: NOW,
      }),
      NOW,
      OWNER_WINDOWS,
    );

    expect(result.canRequest).toBe(false);
    expect(result.blocker).toBe('NOTHING_TO_REFUND');
  });

  it('lets a customer ask about money still held on a cancelled order', () => {
    const result = refundRequestEligibility(
      order({ status: OrderStatus.CANCELLED, paymentStatus: PaymentStatus.PAID, cancelledAt: NOW }),
      NOW,
      OWNER_WINDOWS,
    );

    expect(result.canRequest).toBe(true);
    expect(result.type).toBe(RefundRequestType.REFUND);
  });

  it('says so when it has already been fully refunded', () => {
    const result = refundRequestEligibility(
      order({
        status: OrderStatus.REFUNDED,
        paymentStatus: PaymentStatus.REFUNDED,
        deliveredAt: NOW,
      }),
      NOW,
      OWNER_WINDOWS,
    );

    expect(result.blocker).toBe('NOTHING_TO_REFUND');
    expect(result.message).toContain('already been fully refunded');
  });

  it('does not invite a second ask while one is open', () => {
    const result = refundRequestEligibility(order({ hasOpenRequest: true }), NOW, OWNER_WINDOWS);

    expect(result.canRequest).toBe(false);
    expect(result.blocker).toBe('ALREADY_OPEN');
  });

  it('does not invite an ask while a refund is already being sorted out', () => {
    const result = refundRequestEligibility(
      order({ status: OrderStatus.REFUND_PENDING, paymentStatus: PaymentStatus.REFUND_PENDING }),
      NOW,
      OWNER_WINDOWS,
    );

    expect(result.blocker).toBe('REFUND_IN_PROGRESS');
  });
});
