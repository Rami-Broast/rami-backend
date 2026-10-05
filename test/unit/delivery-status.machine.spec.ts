import { DeliveryStatus } from '@prisma/client';

import {
  canTransitionDelivery,
  deliverySuccessorsOf,
  deliveryTimestampFieldFor,
  isDeliveryTerminal,
} from '../../src/delivery/delivery-status.machine';

describe('delivery status machine', () => {
  describe('the happy path', () => {
    it('walks a delivery through assignment, pickup and drop-off', () => {
      const path: [DeliveryStatus, DeliveryStatus][] = [
        [DeliveryStatus.PENDING_ASSIGNMENT, DeliveryStatus.ASSIGNED],
        [DeliveryStatus.ASSIGNED, DeliveryStatus.PICKED_UP],
        [DeliveryStatus.PICKED_UP, DeliveryStatus.OUT_FOR_DELIVERY],
        [DeliveryStatus.OUT_FOR_DELIVERY, DeliveryStatus.DELIVERED],
      ];

      for (const [from, to] of path) {
        expect(canTransitionDelivery(from, to)).toBe(true);
      }
    });

    it('lets a driver skip the out-for-delivery step and deliver straight from pickup', () => {
      expect(canTransitionDelivery(DeliveryStatus.PICKED_UP, DeliveryStatus.DELIVERED)).toBe(true);
    });
  });

  describe('cancellation before pickup', () => {
    it('allows cancelling while awaiting or holding an assignment', () => {
      expect(
        canTransitionDelivery(DeliveryStatus.PENDING_ASSIGNMENT, DeliveryStatus.CANCELLED),
      ).toBe(true);
      expect(canTransitionDelivery(DeliveryStatus.ASSIGNED, DeliveryStatus.CANCELLED)).toBe(true);
    });

    it('never allows CANCELLED once a delivery has been picked up', () => {
      // Mirrors the order machine's rule that an order cannot be cancelled
      // after pickup — the two machines must agree on where "too late" starts.
      expect(canTransitionDelivery(DeliveryStatus.PICKED_UP, DeliveryStatus.CANCELLED)).toBe(false);
      expect(canTransitionDelivery(DeliveryStatus.OUT_FOR_DELIVERY, DeliveryStatus.CANCELLED)).toBe(
        false,
      );
    });
  });

  describe('failure after pickup', () => {
    it('allows FAILED only from picked-up or out-for-delivery', () => {
      expect(canTransitionDelivery(DeliveryStatus.PICKED_UP, DeliveryStatus.FAILED)).toBe(true);
      expect(canTransitionDelivery(DeliveryStatus.OUT_FOR_DELIVERY, DeliveryStatus.FAILED)).toBe(
        true,
      );
    });

    it('never allows FAILED before a driver has picked the order up', () => {
      expect(canTransitionDelivery(DeliveryStatus.PENDING_ASSIGNMENT, DeliveryStatus.FAILED)).toBe(
        false,
      );
      expect(canTransitionDelivery(DeliveryStatus.ASSIGNED, DeliveryStatus.FAILED)).toBe(false);
    });
  });

  describe('illegal moves', () => {
    it('refuses to skip assignment', () => {
      expect(
        canTransitionDelivery(DeliveryStatus.PENDING_ASSIGNMENT, DeliveryStatus.PICKED_UP),
      ).toBe(false);
    });

    it('refuses to move backwards', () => {
      expect(canTransitionDelivery(DeliveryStatus.PICKED_UP, DeliveryStatus.ASSIGNED)).toBe(false);
    });

    it('allows no move out of a terminal state', () => {
      for (const status of [
        DeliveryStatus.DELIVERED,
        DeliveryStatus.FAILED,
        DeliveryStatus.CANCELLED,
      ]) {
        expect(isDeliveryTerminal(status)).toBe(true);
        expect(deliverySuccessorsOf(status)).toHaveLength(0);
      }
    });
  });

  describe('timestamp mapping', () => {
    it('maps every non-initial status to its timestamp column', () => {
      expect(deliveryTimestampFieldFor(DeliveryStatus.ASSIGNED)).toBe('assignedAt');
      expect(deliveryTimestampFieldFor(DeliveryStatus.PICKED_UP)).toBe('pickedUpAt');
      expect(deliveryTimestampFieldFor(DeliveryStatus.DELIVERED)).toBe('deliveredAt');
      expect(deliveryTimestampFieldFor(DeliveryStatus.CANCELLED)).toBe('cancelledAt');
      expect(deliveryTimestampFieldFor(DeliveryStatus.FAILED)).toBe('failedAt');
    });

    it('has no timestamp column for the initial status', () => {
      expect(deliveryTimestampFieldFor(DeliveryStatus.PENDING_ASSIGNMENT)).toBeNull();
    });
  });
});
