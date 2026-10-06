import { NotificationType, OrderStatus } from '@prisma/client';

import {
  notificationTypeForStatus,
  renderMessage,
} from '../../src/notifications/notification-messages';

describe('notification messages', () => {
  describe('renderMessage', () => {
    it('renders order copy with the order number', () => {
      const message = renderMessage(NotificationType.ORDER_CONFIRMED, { orderNumber: 'ORD-1' });
      expect(message).not.toBeNull();
      expect(message?.title).toBe('Order confirmed');
      expect(message?.body).toContain('ORD-1');
    });

    it('has copy for every customer-facing type it maps', () => {
      const types = [
        NotificationType.ORDER_CONFIRMED,
        NotificationType.PAYMENT_FAILED,
        NotificationType.ORDER_PREPARING,
        NotificationType.ORDER_READY,
        NotificationType.DRIVER_ASSIGNED,
        NotificationType.OUT_FOR_DELIVERY,
        NotificationType.ORDER_DELIVERED,
        NotificationType.ORDER_CANCELLED,
        NotificationType.REFUND_UPDATE,
      ];
      for (const type of types) {
        expect(renderMessage(type, { orderNumber: 'ORD-X' })).not.toBeNull();
      }
    });

    it('returns null for a type with no customer copy', () => {
      expect(renderMessage(NotificationType.OTP, { orderNumber: 'ORD-1' })).toBeNull();
      expect(renderMessage(NotificationType.PROMOTION, { orderNumber: 'ORD-1' })).toBeNull();
    });
  });

  describe('notificationTypeForStatus', () => {
    it('maps lifecycle states to their notification type', () => {
      expect(notificationTypeForStatus(OrderStatus.CONFIRMED)).toBe(
        NotificationType.ORDER_CONFIRMED,
      );
      expect(notificationTypeForStatus(OrderStatus.PREPARING)).toBe(
        NotificationType.ORDER_PREPARING,
      );
      expect(notificationTypeForStatus(OrderStatus.READY)).toBe(NotificationType.ORDER_READY);
      expect(notificationTypeForStatus(OrderStatus.DELIVERED)).toBe(
        NotificationType.ORDER_DELIVERED,
      );
      expect(notificationTypeForStatus(OrderStatus.CANCELLED)).toBe(
        NotificationType.ORDER_CANCELLED,
      );
      expect(notificationTypeForStatus(OrderStatus.PAYMENT_FAILED)).toBe(
        NotificationType.PAYMENT_FAILED,
      );
    });

    it('returns null for states with no customer message', () => {
      expect(notificationTypeForStatus(OrderStatus.PENDING_PAYMENT)).toBeNull();
      expect(notificationTypeForStatus(OrderStatus.REFUND_PENDING)).toBeNull();
    });
  });
});
