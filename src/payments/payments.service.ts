import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  OrderStatus,
  PaymentAttemptStatus,
  PaymentStatus,
  Prisma,
  WebhookProcessingStatus,
} from '@prisma/client';

import { Actor, isCustomer } from '../auth/types/actor';
import { resolveRequestedBranches } from '../branches/branch-scope';
import { AppConfigService } from '../config/app-config.service';
import { buildPaginationMeta } from '../common/dto/pagination.dto';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrdersService } from '../orders/orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { RefundsService } from '../refunds/refunds.service';
import { ZatcaInvoicingService } from '../zatca-invoicing/zatca-invoicing.service';
import { InitiatePaymentDto, ListPaymentsQueryDto } from './dto/payment.dto';
import { MockPaymentGateway } from './gateway/mock-payment.gateway';
import {
  GatewayPaymentStatus,
  PAYMENT_GATEWAY,
  PaymentGateway,
} from './gateway/payment-gateway.interface';

/** The safe, client-facing view of a payment. No credential ever appears here. */
const paymentView = {
  id: true,
  orderId: true,
  status: true,
  method: true,
  currency: true,
  amountMinor: true,
  capturedAmountMinor: true,
  refundedAmountMinor: true,
  gatewayName: true,
  gatewayReference: true,
  gatewayPaymentId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PaymentSelect;

/**
 * Payments (Phase 11).
 *
 * Sits between the order engine and a payment gateway, upholding the
 * specification's money rules:
 *
 *   - **Client-side success is never proof of payment.** A charge is only ever
 *     advanced to PAID by a signature-verified webhook or a server-initiated
 *     gateway check — never by a client saying it worked.
 *   - **Fulfilment and money stay separate.** A verified successful payment sets
 *     `Order.paymentStatus = PAID` and, only if the order is still awaiting
 *     payment, confirms it for the kitchen through the order engine's single
 *     transition choke point.
 *   - **Every financial operation is idempotent.** Attempts carry a unique
 *     idempotency key; webhook events are unique per gateway event id, so a
 *     replayed delivery is recorded once and acted on once.
 *   - **Secrets stay on the backend.** The gateway adapter holds all credentials;
 *     nothing gateway-secret is ever returned to a client or logged.
 *
 * The gateway itself is injected behind the {@link PaymentGateway} interface, so
 * this service is identical whether the adapter is the sandbox mock or Tap.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly refunds: RefundsService,
    private readonly notifications: NotificationsService,
    private readonly loyalty: LoyaltyService,
    private readonly config: AppConfigService,
    private readonly zatca: ZatcaInvoicingService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  // ===========================================================================
  // Customer: initiate and read
  // ===========================================================================

  /**
   * Starts an online charge for one of the customer's own orders.
   *
   * Creates (or reuses) the order's Payment and records a new attempt keyed by
   * an idempotency key, so a double-tap or a retried request never charges
   * twice. Returns what the client must do next — it does **not** mark anything
   * paid; only a verified webhook does that.
   */
  async initiate(actor: Actor, orderId: string, dto: InitiatePaymentDto) {
    if (!isCustomer(actor)) {
      throw new ForbiddenException('Only a customer can pay for an order.');
    }

    const order = await this.prisma.order.findFirst({
      where: { id: orderId, customerId: actor.id, deletedAt: null },
      select: { id: true, orderNumber: true, status: true, totalMinor: true, customerId: true },
    });

    if (!order) {
      throw new NotFoundException('Order not found.');
    }

    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      // A COD order is already confirmed; a paid order is done; a cancelled one
      // cannot be paid. None of these are payable online.
      throw new ConflictException('This order is not awaiting online payment.');
    }

    const idempotencyKey = dto.idempotencyKey ?? randomUUID();

    // Idempotent replay: the same key returns the attempt already made, never a
    // second charge.
    const existingAttempt = await this.prisma.paymentAttempt.findUnique({
      where: { idempotencyKey },
      select: { orderId: true, paymentId: true },
    });

    if (existingAttempt) {
      if (existingAttempt.orderId !== order.id) {
        throw new ConflictException(
          'This idempotency key has already been used for another order.',
        );
      }

      const payment = await this.prisma.payment.findUniqueOrThrow({
        where: { id: existingAttempt.paymentId },
        select: paymentView,
      });

      return { payment, clientAction: null, replayed: true };
    }

    const customer = await this.prisma.customer.findUniqueOrThrow({
      where: { id: actor.id },
      select: { id: true, phone: true, email: true },
    });

    // Create the Payment (one per order for this gateway) and the attempt in one
    // transaction. The unique idempotencyKey is the concurrency guard.
    const { payment, attemptId } = await this.prisma.$transaction(async (tx) => {
      const existingPayment = await tx.payment.findFirst({
        where: { orderId: order.id, gatewayName: this.gateway.name },
      });

      if (existingPayment && existingPayment.status === PaymentStatus.PAID) {
        throw new ConflictException('This order is already paid.');
      }

      const payment =
        existingPayment ??
        (await tx.payment.create({
          data: {
            orderId: order.id,
            status: PaymentStatus.PENDING,
            method: dto.method ?? null,
            amountMinor: order.totalMinor,
            gatewayName: this.gateway.name,
          },
        }));

      const attemptCount = await tx.paymentAttempt.count({ where: { paymentId: payment.id } });

      const attempt = await tx.paymentAttempt.create({
        data: {
          paymentId: payment.id,
          orderId: order.id,
          attemptNumber: attemptCount + 1,
          status: PaymentAttemptStatus.INITIATED,
          method: dto.method ?? null,
          amountMinor: order.totalMinor,
          idempotencyKey,
        },
      });

      return { payment, attemptId: attempt.id };
    });

    // The gateway call is made outside the transaction so a slow gateway never
    // holds a database lock.
    const charge = await this.gateway.createCharge({
      paymentId: payment.id,
      orderId: order.id,
      orderNumber: order.orderNumber,
      amountMinor: order.totalMinor,
      currency: 'SAR',
      method: dto.method,
      idempotencyKey,
      customer: { id: customer.id, phone: customer.phone, email: customer.email ?? undefined },
      returnUrl: dto.returnUrl,
    });

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.paymentAttempt.update({
        where: { id: attemptId },
        data: {
          status: PaymentAttemptStatus.PENDING,
          gatewayAttemptId: charge.gatewayPaymentId,
        },
      });

      return tx.payment.update({
        where: { id: payment.id },
        data: {
          gatewayPaymentId: charge.gatewayPaymentId,
          gatewayReference: charge.gatewayReference,
        },
        select: paymentView,
      });
    });

    // Sandbox: the mock gateway has no hosted page and no bank, so nothing
    // would ever deliver the webhook that completes this charge and the order
    // would sit in PENDING_PAYMENT for ever — invisible to the branch and
    // untrackable for the customer. Settle it here, through the ordinary
    // signed-webhook path, so the demo exercises the real flow end to end.
    const settled = await this.autoSettleInSandbox(charge.gatewayPaymentId);

    return {
      payment: settled ?? updated,
      clientAction: charge.clientAction,
      replayed: false,
    };
  }

  /**
   * Sandbox only: delivers the mock gateway's own signed success webhook.
   *
   * This is the sandbox standing in for the bank, not the client being believed
   * — the event is signed, its signature is verified, and it is ingested by
   * `handleWebhook` like any other. Best-effort: a failure here must never turn
   * a created charge into a failed request, because the payment genuinely
   * exists by this point and the client polls the server for its true state.
   */
  private async autoSettleInSandbox(gatewayPaymentId: string) {
    if (
      !this.config.payments.sandbox ||
      !this.config.payments.mockAutoSettle ||
      !(this.gateway instanceof MockPaymentGateway)
    ) {
      return null;
    }

    try {
      await this.simulateWebhook(gatewayPaymentId, 'SUCCEEDED');

      return this.prisma.payment.findFirst({
        where: { gatewayName: this.gateway.name, gatewayPaymentId },
        select: paymentView,
      });
    } catch (error) {
      this.logger.warn(
        `Sandbox auto-settle failed for ${gatewayPaymentId}; the payment stays pending: ${(error as Error).message}`,
      );
      return null;
    }
  }

  /** The payment on one of the customer's own orders, if any. */
  async getForCustomer(actor: Actor, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, customerId: actor.id, deletedAt: null },
      select: { id: true },
    });

    if (!order) {
      throw new NotFoundException('Order not found.');
    }

    const payment = await this.prisma.payment.findFirst({
      where: { orderId: order.id },
      select: paymentView,
      orderBy: { createdAt: 'desc' },
    });

    if (!payment) {
      throw new NotFoundException('No payment has been started for this order.');
    }

    return payment;
  }

  // ===========================================================================
  // Webhooks
  // ===========================================================================

  /**
   * Ingests a gateway webhook.
   *
   * Verifies the signature against the raw bytes first; an unverified event is
   * recorded for audit but never acted upon. A verified event is processed
   * exactly once — the unique `(gatewayName, gatewayEventId)` constraint makes a
   * replayed delivery a no-op.
   */
  async handleWebhook(
    gatewayName: string,
    rawBody: Buffer | string,
    signature: string | undefined,
  ) {
    if (gatewayName !== this.gateway.name) {
      throw new NotFoundException('Unknown payment gateway.');
    }

    const verified = this.gateway.verifyWebhookSignature(rawBody, signature);

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString());
    } catch {
      throw new BadRequestException('Malformed webhook body.');
    }

    if (!verified) {
      // Record the rejection for audit where we can, then refuse. We do not act
      // on anything an unverified body claims.
      await this.recordUnverified(gatewayName, payload);
      throw new UnauthorizedException('Invalid webhook signature.');
    }

    const event = this.gateway.parseWebhookEvent(payload);

    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.paymentWebhookEvent.findUnique({
        where: {
          gatewayName_gatewayEventId: { gatewayName, gatewayEventId: event.gatewayEventId },
        },
      });

      if (existing?.processingStatus === WebhookProcessingStatus.PROCESSED) {
        return { status: 'duplicate' as const };
      }

      const eventRow =
        existing ??
        (await tx.paymentWebhookEvent.create({
          data: {
            gatewayName,
            gatewayEventId: event.gatewayEventId,
            eventType: event.eventType,
            signatureVerified: true,
            payload: payload as Prisma.InputJsonValue,
            processingStatus: WebhookProcessingStatus.RECEIVED,
            attempts: 1,
          },
        }));

      // A refund event carries a gateway refund id; the refunds module applies
      // it. Everything else is a charge event on the original payment.
      if (event.gatewayRefundId) {
        const { outcome, orderId } = await this.refunds.applyRefundEvent(tx, event);
        await tx.paymentWebhookEvent.update({
          where: { id: eventRow.id },
          data:
            outcome === 'unmatched'
              ? {
                  processingStatus: WebhookProcessingStatus.FAILED,
                  processingError: 'No matching refund for gateway refund id.',
                }
              : { processingStatus: WebhookProcessingStatus.PROCESSED, processedAt: new Date() },
        });
        return {
          status: outcome,
          notify:
            outcome !== 'unmatched' && orderId
              ? ({ orderId, kind: 'REFUND_UPDATE' } as const)
              : undefined,
        };
      }

      const payment = event.gatewayPaymentId
        ? await tx.payment.findFirst({
            where: { gatewayName, gatewayPaymentId: event.gatewayPaymentId },
          })
        : null;

      if (!payment) {
        await tx.paymentWebhookEvent.update({
          where: { id: eventRow.id },
          data: {
            processingStatus: WebhookProcessingStatus.FAILED,
            processingError: 'No matching payment for gateway payment id.',
          },
        });
        return { status: 'unmatched' as const };
      }

      await this.applyEventToPayment(tx, payment.id, payment.orderId, event.status, {
        amountMinor: event.amountMinor,
        feeMinor: event.feeMinor,
        gatewayReference: event.gatewayReference,
        failureReason: event.failureReason,
      });

      await tx.paymentWebhookEvent.update({
        where: { id: eventRow.id },
        data: {
          processingStatus: WebhookProcessingStatus.PROCESSED,
          processedAt: new Date(),
          paymentId: payment.id,
          orderId: payment.orderId,
        },
      });

      const notify =
        event.status === 'SUCCEEDED'
          ? ({ orderId: payment.orderId, kind: 'ORDER_CONFIRMED' } as const)
          : event.status === 'FAILED' || event.status === 'CANCELLED'
            ? ({ orderId: payment.orderId, kind: 'PAYMENT_FAILED' } as const)
            : undefined;

      return { status: 'processed' as const, notify };
    });

    // Post-commit: notify the customer of the resulting state. Best-effort, and
    // never allowed to turn a successfully processed webhook into a failure.
    if ('notify' in result && result.notify) {
      const { orderId, kind } = result.notify;
      if (kind === 'ORDER_CONFIRMED') {
        await this.notifications.onOrderStatus(orderId, OrderStatus.CONFIRMED);
        // Money is now real (a verified webhook), so issue the ZATCA tax invoice.
        // Best-effort and idempotent — never turns a processed webhook into a failure.
        await this.zatca.issueInvoiceForOrder(orderId);
      } else if (kind === 'PAYMENT_FAILED') {
        await this.notifications.onPaymentFailed(orderId);
      } else {
        await this.notifications.onRefundUpdate(orderId);
        // Reverse loyalty points in proportion to what was refunded.
        await this.loyalty.reverseForRefund(orderId);
      }
    }

    return { status: result.status };
  }

  /**
   * Sandbox only: completes a payment by delivering a genuine, correctly signed
   * webhook, as a real gateway would. This is how a dev or the customer app
   * drives a sandbox charge to success or failure without real money — the
   * outcome still flows through the exact verification and processing path.
   */
  async simulateWebhook(
    gatewayPaymentId: string,
    outcome: GatewayPaymentStatus,
    amountMinor?: number,
  ) {
    if (!this.config.payments.sandbox || !(this.gateway instanceof MockPaymentGateway)) {
      throw new NotFoundException('Simulation is only available on the sandbox mock gateway.');
    }

    const payment = await this.prisma.payment.findFirst({
      where: { gatewayName: this.gateway.name, gatewayPaymentId },
      select: { amountMinor: true },
    });

    if (!payment) {
      throw new NotFoundException('No payment for that gateway payment id.');
    }

    const { rawBody, signature } = this.gateway.buildWebhook({
      gatewayPaymentId,
      status: outcome,
      amountMinor: amountMinor ?? payment.amountMinor,
      feeMinor:
        outcome === 'SUCCEEDED'
          ? Math.round((amountMinor ?? payment.amountMinor) * 0.025)
          : undefined,
      gatewayReference: `mock_ref_${gatewayPaymentId}`,
    });

    return this.handleWebhook(this.gateway.name, rawBody, signature);
  }

  /**
   * Sandbox only: completes a refund by delivering a genuine, correctly signed
   * refund webhook — the same path a real gateway uses when a refund settles.
   */
  async simulateRefundWebhook(gatewayRefundId: string, outcome: GatewayPaymentStatus) {
    if (!this.config.payments.sandbox || !(this.gateway instanceof MockPaymentGateway)) {
      throw new NotFoundException('Simulation is only available on the sandbox mock gateway.');
    }

    const refund = await this.prisma.refund.findFirst({
      where: { gatewayRefundId },
      select: { amountMinor: true },
    });

    if (!refund) {
      throw new NotFoundException('No refund for that gateway refund id.');
    }

    const { rawBody, signature } = this.gateway.buildRefundWebhook({
      gatewayRefundId,
      status: outcome,
      amountMinor: refund.amountMinor,
    });

    return this.handleWebhook(this.gateway.name, rawBody, signature);
  }

  // ===========================================================================
  // Staff reads
  // ===========================================================================

  async listForStaff(actor: Actor, query: ListPaymentsQueryDto) {
    const orderFilter = resolveRequestedBranches(actor, query.branchId);

    const where: Prisma.PaymentWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.orderId ? { orderId: query.orderId } : {}),
      // Branch isolation is applied through the owning order.
      order: { deletedAt: null, ...orderFilter },
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.payment.findMany({
        where,
        select: {
          ...paymentView,
          order: { select: { orderNumber: true, referenceId: true, branchId: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.payment.count({ where }),
    ]);

    return { data, meta: buildPaginationMeta(total, query) };
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  private async recordUnverified(gatewayName: string, payload: unknown): Promise<void> {
    // Best effort: only if the payload carries something usable as an event id.
    const eventId =
      payload && typeof payload === 'object' && 'id' in payload && typeof payload.id === 'string'
        ? payload.id
        : `unverified_${randomUUID()}`;

    try {
      await this.prisma.paymentWebhookEvent.upsert({
        where: { gatewayName_gatewayEventId: { gatewayName, gatewayEventId: eventId } },
        update: { attempts: { increment: 1 } },
        create: {
          gatewayName,
          gatewayEventId: eventId,
          eventType: 'unknown',
          signatureVerified: false,
          payload: payload as Prisma.InputJsonValue,
          processingStatus: WebhookProcessingStatus.FAILED,
          processingError: 'Signature verification failed.',
          attempts: 1,
        },
      });
    } catch (error) {
      // Never let audit-recording failure mask the security refusal.
      this.logger.warn(`Could not record unverified webhook: ${(error as Error).message}`);
    }
  }

  /**
   * Applies a verified event's outcome to the payment and its order, in the
   * caller's transaction. Advancing the order goes through the order engine's
   * single transition choke point, attributed to the system.
   */
  private async applyEventToPayment(
    tx: Prisma.TransactionClient,
    paymentId: string,
    orderId: string,
    status: GatewayPaymentStatus | undefined,
    details: {
      amountMinor?: number;
      feeMinor?: number;
      gatewayReference?: string;
      failureReason?: string;
    },
  ): Promise<void> {
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { id: true, status: true, type: true, branchId: true },
    });

    if (status === 'SUCCEEDED') {
      const payment = await tx.payment.findUniqueOrThrow({
        where: { id: paymentId },
        select: { amountMinor: true },
      });

      await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: PaymentStatus.PAID,
          capturedAmountMinor: details.amountMinor ?? payment.amountMinor,
          capturedAt: new Date(),
          gatewayFeeMinor: details.feeMinor,
          gatewayReference: details.gatewayReference,
        },
      });

      await tx.order.update({
        where: { id: orderId },
        data: { paymentStatus: PaymentStatus.PAID },
      });

      // Advance for the kitchen only if the order is still awaiting payment —
      // never re-drive an order that has already moved on. A branch with
      // autoAcceptOrders=false parks at AWAITING_ACCEPTANCE for a human to
      // accept or reject; the default goes straight to CONFIRMED.
      if (order.status === OrderStatus.PENDING_PAYMENT) {
        const branchSetting = await tx.branchSetting.findUnique({
          where: { branchId: order.branchId },
          select: { autoAcceptOrders: true },
        });
        const nextStatus =
          branchSetting?.autoAcceptOrders === false
            ? OrderStatus.AWAITING_ACCEPTANCE
            : OrderStatus.CONFIRMED;
        await this.orders.applyTransition(tx, order, nextStatus, null, {
          reason:
            nextStatus === OrderStatus.CONFIRMED
              ? 'Payment received'
              : 'Payment received — awaiting branch acceptance',
        });
      }

      return;
    }

    if (status === 'FAILED' || status === 'CANCELLED') {
      await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: status === 'FAILED' ? PaymentStatus.FAILED : PaymentStatus.CANCELLED,
          failedAt: new Date(),
          failureReason: details.failureReason ?? 'Payment was not completed.',
        },
      });

      await tx.order.update({
        where: { id: orderId },
        data: {
          paymentStatus: status === 'FAILED' ? PaymentStatus.FAILED : PaymentStatus.CANCELLED,
        },
      });

      if (order.status === OrderStatus.PENDING_PAYMENT) {
        await this.orders.applyTransition(tx, order, OrderStatus.PAYMENT_FAILED, null, {
          reason: details.failureReason ?? 'Payment failed',
        });
      }
    }

    // A PENDING status advances nothing — we wait for a terminal event.
  }
}
