import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  NotificationChannel,
  NotificationDeliveryStatus,
  NotificationType,
  OrderStatus,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { RenderedMessage, notificationTypeForStatus, renderMessage } from './notification-messages';
import { PUSH_SENDER, PushSender } from './push/push.port';
import { SMS_SENDER, SmsSender } from './sms/sms.port';

/**
 * Notifications (Phase 16).
 *
 * Turns an order/payment/refund event into a customer notification, recorded in
 * `Notification` with a per-channel `NotificationDelivery`, and sent over the
 * SMS and push ports. Both ports are provider abstractions with mock adapters,
 * so the whole flow works before any SMS/push contract exists (spec §20 — use
 * provider abstractions so vendors can be changed).
 *
 * **Trigger calls are best-effort and must never break the operation that
 * caused them.** A failed send is recorded on the delivery row and logged; it
 * does not throw back into the order or payment flow. Callers invoke these after
 * their own database work has committed.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
    @Inject(PUSH_SENDER) private readonly push: PushSender,
  ) {}

  /** Fires the notification matching a fulfilment status change, if any. */
  async onOrderStatus(orderId: string, status: OrderStatus): Promise<void> {
    const type = notificationTypeForStatus(status);
    if (type) {
      await this.dispatch(orderId, type);
    }
  }

  onPaymentFailed(orderId: string): Promise<void> {
    return this.dispatch(orderId, NotificationType.PAYMENT_FAILED);
  }

  onRefundUpdate(orderId: string): Promise<void> {
    return this.dispatch(orderId, NotificationType.REFUND_UPDATE);
  }

  /**
   * Builds, records and sends one notification to an order's customer over every
   * configured channel. Swallows and records failures — see the class note.
   */
  async dispatch(
    orderId: string,
    type: NotificationType,
    /**
     * Copy to send instead of this type's standard message. Used where one type
     * covers several distinct events — a refund *request* being received,
     * approved or declined are all REFUND_UPDATE, and a customer needs to be
     * told which. The type still decides which feed the message lands in.
     */
    override?: RenderedMessage,
  ): Promise<void> {
    try {
      const order = await this.prisma.order.findFirst({
        where: { id: orderId },
        select: {
          id: true,
          orderNumber: true,
          referenceId: true,
          customerId: true,
          customer: { select: { id: true, phone: true } },
          branch: { select: { name: true } },
        },
      });

      if (!order) {
        return;
      }

      const message =
        override ??
        renderMessage(type, {
          orderNumber: order.orderNumber,
          branchName: order.branch.name,
        });

      if (!message) {
        return;
      }

      const notification = await this.prisma.notification.create({
        data: {
          type,
          customerId: order.customerId,
          orderId: order.id,
          title: message.title,
          body: message.body,
          data: {
            orderId: order.id,
            orderNumber: order.orderNumber,
            referenceId: order.referenceId,
          },
          deliveries: {
            create: [
              {
                channel: NotificationChannel.SMS,
                provider: 'pending',
                status: NotificationDeliveryStatus.QUEUED,
              },
              {
                channel: NotificationChannel.PUSH,
                provider: 'pending',
                status: NotificationDeliveryStatus.QUEUED,
              },
            ],
          },
        },
        include: { deliveries: true },
      });

      const smsDelivery = notification.deliveries.find(
        (d) => d.channel === NotificationChannel.SMS,
      );
      const pushDelivery = notification.deliveries.find(
        (d) => d.channel === NotificationChannel.PUSH,
      );

      await Promise.all([
        smsDelivery
          ? this.sendSms(smsDelivery.id, order.customer.phone, message.body)
          : Promise.resolve(),
        pushDelivery
          ? this.sendPush(pushDelivery.id, order.customer.id, message)
          : Promise.resolve(),
      ]);
    } catch (error) {
      // A notification must never break the operation that triggered it.
      this.logger.warn(
        `Failed to dispatch ${type} for order ${orderId}: ${(error as Error).message}`,
      );
    }
  }

  private async sendSms(deliveryId: string, phone: string, body: string): Promise<void> {
    try {
      const result = await this.sms.send({ to: phone, body });
      await this.prisma.notificationDelivery.update({
        where: { id: deliveryId },
        data: {
          provider: result.provider,
          providerMessageId: result.providerMessageId,
          status: NotificationDeliveryStatus.SENT,
          sentAt: result.acceptedAt,
          attempts: { increment: 1 },
        },
      });
    } catch (error) {
      await this.markFailed(deliveryId, error);
    }
  }

  private async sendPush(
    deliveryId: string,
    customerId: string,
    message: { title: string; body: string },
  ): Promise<void> {
    try {
      const result = await this.push.send({
        customerId,
        title: message.title,
        body: message.body,
      });
      await this.prisma.notificationDelivery.update({
        where: { id: deliveryId },
        data: {
          provider: result.provider,
          providerMessageId: result.providerMessageId,
          status: NotificationDeliveryStatus.SENT,
          sentAt: result.acceptedAt,
          attempts: { increment: 1 },
        },
      });
    } catch (error) {
      await this.markFailed(deliveryId, error);
    }
  }

  private async markFailed(deliveryId: string, error: unknown): Promise<void> {
    await this.prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: {
        status: NotificationDeliveryStatus.FAILED,
        failedAt: new Date(),
        failureReason: (error as Error).message.slice(0, 500),
        attempts: { increment: 1 },
      },
    });
  }
}
