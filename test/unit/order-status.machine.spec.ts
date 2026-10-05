import { OrderStatus, OrderType } from '@prisma/client';

import {
  allowedNextStatuses,
  canTransition,
  isCustomerCancellable,
  isTerminal,
  successorsOf,
  timestampFieldFor,
} from '../../src/orders/order-status.machine';

describe('order status machine', () => {
  describe('the happy path', () => {
    it('walks a delivery order through the driver leg', () => {
      const path: [OrderStatus, OrderStatus][] = [
        [OrderStatus.PENDING_PAYMENT, OrderStatus.CONFIRMED],
        [OrderStatus.CONFIRMED, OrderStatus.PREPARING],
        [OrderStatus.PREPARING, OrderStatus.READY],
        [OrderStatus.READY, OrderStatus.DRIVER_ASSIGNED],
        [OrderStatus.DRIVER_ASSIGNED, OrderStatus.PICKED_UP],
        [OrderStatus.PICKED_UP, OrderStatus.OUT_FOR_DELIVERY],
        [OrderStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERED],
      ];

      for (const [from, to] of path) {
        expect(canTransition(from, to, OrderType.DELIVERY)).toBe(true);
      }
    });

    it('lets a pickup order be collected straight from ready', () => {
      expect(canTransition(OrderStatus.READY, OrderStatus.DELIVERED, OrderType.PICKUP)).toBe(true);
    });
  });

  describe('order-type narrowing', () => {
    it('never routes a pickup order to a driver', () => {
      expect(canTransition(OrderStatus.READY, OrderStatus.DRIVER_ASSIGNED, OrderType.PICKUP)).toBe(
        false,
      );
      const next = allowedNextStatuses(OrderStatus.READY, OrderType.PICKUP);
      expect(next).not.toContain(OrderStatus.DRIVER_ASSIGNED);
      expect(next).not.toContain(OrderStatus.PICKED_UP);
      expect(next).not.toContain(OrderStatus.OUT_FOR_DELIVERY);
    });

    it('does not let a delivery order jump from ready straight to delivered', () => {
      // A delivery order reaches DELIVERED only through the driver leg — being
      // able to skip it would let a branch mark an order delivered that never
      // left the kitchen.
      expect(canTransition(OrderStatus.READY, OrderStatus.DELIVERED, OrderType.DELIVERY)).toBe(
        false,
      );
    });

    it('offers a delivery order the driver hand-off from ready', () => {
      const next = allowedNextStatuses(OrderStatus.READY, OrderType.DELIVERY);
      expect(next).toContain(OrderStatus.DRIVER_ASSIGNED);
      expect(next).not.toContain(OrderStatus.DELIVERED);
    });
  });

  describe('returning a delivery to the pool', () => {
    it('allows DRIVER_ASSIGNED back to READY', () => {
      // Taking a delivery off its driver before pickup. The order has not
      // changed — only who is carrying it — so it belongs back in the pool
      // exactly where it was. Without this the delivery was stranded and
      // cancelling the customer's order was the only way out.
      expect(
        canTransition(OrderStatus.DRIVER_ASSIGNED, OrderStatus.READY, OrderType.DELIVERY),
      ).toBe(true);
    });

    it('does not allow it once the order has been picked up', () => {
      // The food is in the car; moving the record would lie about where it is.
      expect(canTransition(OrderStatus.PICKED_UP, OrderStatus.READY, OrderType.DELIVERY)).toBe(
        false,
      );
      expect(
        canTransition(OrderStatus.OUT_FOR_DELIVERY, OrderStatus.READY, OrderType.DELIVERY),
      ).toBe(false);
    });
  });

  describe('illegal moves', () => {
    it('refuses to skip states', () => {
      expect(canTransition(OrderStatus.CONFIRMED, OrderStatus.READY, OrderType.DELIVERY)).toBe(
        false,
      );
      expect(
        canTransition(OrderStatus.PENDING_PAYMENT, OrderStatus.PREPARING, OrderType.PICKUP),
      ).toBe(false);
    });

    it('refuses to move backwards', () => {
      expect(canTransition(OrderStatus.READY, OrderStatus.PREPARING, OrderType.DELIVERY)).toBe(
        false,
      );
    });

    it('allows no move out of a terminal state', () => {
      for (const status of [
        OrderStatus.CANCELLED,
        OrderStatus.REFUNDED,
        OrderStatus.PAYMENT_FAILED,
      ]) {
        expect(isTerminal(status)).toBe(true);
        expect(successorsOf(status)).toHaveLength(0);
      }
    });
  });

  describe('cancellation', () => {
    it('lets a customer cancel only before preparation begins', () => {
      expect(isCustomerCancellable(OrderStatus.PENDING_PAYMENT)).toBe(true);
      expect(isCustomerCancellable(OrderStatus.CONFIRMED)).toBe(true);
      expect(isCustomerCancellable(OrderStatus.PREPARING)).toBe(false);
      expect(isCustomerCancellable(OrderStatus.READY)).toBe(false);
      expect(isCustomerCancellable(OrderStatus.OUT_FOR_DELIVERY)).toBe(false);
    });

    it('lets staff cancel up to and including the driver hand-off but not after pickup', () => {
      const cancellable = [
        OrderStatus.PENDING_PAYMENT,
        OrderStatus.CONFIRMED,
        OrderStatus.PREPARING,
        OrderStatus.READY,
        OrderStatus.DRIVER_ASSIGNED,
      ];
      for (const status of cancellable) {
        expect(canTransition(status, OrderStatus.CANCELLED, OrderType.DELIVERY)).toBe(true);
      }
      // Once the order is with the driver and moving, it is too late to cancel.
      expect(
        canTransition(OrderStatus.OUT_FOR_DELIVERY, OrderStatus.CANCELLED, OrderType.DELIVERY),
      ).toBe(false);
      expect(canTransition(OrderStatus.DELIVERED, OrderStatus.CANCELLED, OrderType.DELIVERY)).toBe(
        false,
      );
    });
  });

  describe('refund lifecycle', () => {
    it('reaches refund states only from delivered', () => {
      expect(
        canTransition(OrderStatus.DELIVERED, OrderStatus.REFUND_PENDING, OrderType.PICKUP),
      ).toBe(true);
      expect(
        canTransition(OrderStatus.REFUND_PENDING, OrderStatus.REFUNDED, OrderType.PICKUP),
      ).toBe(true);
      expect(
        canTransition(OrderStatus.REFUND_PENDING, OrderStatus.PARTIALLY_REFUNDED, OrderType.PICKUP),
      ).toBe(true);
      expect(
        canTransition(OrderStatus.PARTIALLY_REFUNDED, OrderStatus.REFUND_PENDING, OrderType.PICKUP),
      ).toBe(true);
    });
  });

  describe('timestamp mapping', () => {
    it('maps lifecycle states to their timestamp column', () => {
      expect(timestampFieldFor(OrderStatus.CONFIRMED)).toBe('confirmedAt');
      expect(timestampFieldFor(OrderStatus.PREPARING)).toBe('preparingAt');
      expect(timestampFieldFor(OrderStatus.READY)).toBe('readyAt');
      expect(timestampFieldFor(OrderStatus.DELIVERED)).toBe('deliveredAt');
      expect(timestampFieldFor(OrderStatus.CANCELLED)).toBe('cancelledAt');
    });

    it('has no timestamp column for intermediate delivery states', () => {
      expect(timestampFieldFor(OrderStatus.DRIVER_ASSIGNED)).toBeNull();
      expect(timestampFieldFor(OrderStatus.PENDING_PAYMENT)).toBeNull();
    });
  });
});
