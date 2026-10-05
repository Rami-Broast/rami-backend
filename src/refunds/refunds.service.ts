import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PaymentStatus, Prisma, RefundStatus } from '@prisma/client';

import { Actor, isStaff } from '../auth/types/actor';
import { assertBranchAccess, resolveRequestedBranches } from '../branches/branch-scope';
import { buildPaginationMeta } from '../common/dto/pagination.dto';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRefundDto, ListRefundsQueryDto } from './dto/refund.dto';
import {
  ParsedWebhookEvent,
  PAYMENT_GATEWAY,
  PaymentGateway,
} from '../payments/gateway/payment-gateway.interface';

/** The safe view of a refund returned to staff. */
const refundView = {
  id: true,
  paymentId: true,
  orderId: true,
  currency: true,
  amountMinor: true,
  status: true,
  reason: true,
  requestedByUserId: true,
  gatewayRefundId: true,
  requestedAt: true,
  completedAt: true,
  failedAt: true,
  failureReason: true,
} satisfies Prisma.RefundSelect;

/**
 * Refunds (Phase 12).
 *
 * Upholds the refund rules from the specification (§17):
 *
 *   - **Only an authorized staff member** issues a refund (`refunds:write`),
 *     and only against a payment in a branch they may reach.
 *   - **A refund may never exceed the remaining refundable amount** —
 *     `captured − alreadyRefunded` — checked at creation and again, defensively,
 *     at completion.
 *   - **Every refund is idempotent** by a unique idempotency key: a retried or
 *     double-clicked request returns the existing refund, never a second one.
 *   - **Completion is asynchronous.** Creating a refund puts it PENDING and the
 *     order into REFUND_PENDING; it is only marked COMPLETED and the money
 *     applied when a verified gateway event confirms it. Nothing here assumes an
 *     instant refund.
 *   - **Reason, actor, timestamps, gateway reference and status** are all
 *     recorded, and the `Refund` row is the audited record of the action.
 *
 * Money moves on `Payment.refundedAmountMinor` / `Payment.status` and
 * `Order.paymentStatus`. Fulfilment (`Order.status`) is left untouched — the two
 * columns are independent.
 */
@Injectable()
export class RefundsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  // ===========================================================================
  // Creation
  // ===========================================================================

  async createRefund(actor: Actor, dto: CreateRefundDto) {
    const payment = await this.prisma.payment.findFirst({
      where: { id: dto.paymentId },
      select: {
        id: true,
        status: true,
        capturedAmountMinor: true,
        refundedAmountMinor: true,
        gatewayName: true,
        gatewayPaymentId: true,
        orderId: true,
        currency: true,
        order: { select: { branchId: true } },
      },
    });

    if (!payment) {
      throw new NotFoundException('Payment not found.');
    }

    // Branch isolation: a branch admin can only refund their own branch's takings.
    assertBranchAccess(actor, payment.order.branchId);

    if (!payment.gatewayPaymentId) {
      // Cash on delivery and other non-gateway takings are settled off-platform;
      // there is nothing to refund through a gateway here.
      throw new BadRequestException(
        'This payment was not taken through a gateway and cannot be refunded here.',
      );
    }

    if (
      payment.status !== PaymentStatus.PAID &&
      payment.status !== PaymentStatus.PARTIALLY_REFUNDED
    ) {
      throw new ConflictException('This payment is not in a refundable state.');
    }

    const refundable = payment.capturedAmountMinor - payment.refundedAmountMinor;
    const amountMinor = dto.amountMinor ?? refundable;

    if (amountMinor <= 0) {
      throw new BadRequestException('The refund amount must be greater than zero.');
    }

    if (amountMinor > refundable) {
      throw new BadRequestException(
        `The refund amount exceeds the ${refundable} remaining refundable.`,
      );
    }

    const idempotencyKey = dto.idempotencyKey ?? randomUUID();

    // Idempotent replay.
    const existing = await this.prisma.refund.findUnique({
      where: { idempotencyKey },
      select: { ...refundView, paymentId: true },
    });

    if (existing) {
      if (existing.paymentId !== payment.id) {
        throw new ConflictException(
          'This idempotency key has already been used for another payment.',
        );
      }
      return existing;
    }

    // Create the refund PENDING and move the order into REFUND_PENDING, in one
    // transaction. The unique idempotencyKey is the concurrency guard.
    const refund = await this.prisma
      .$transaction(async (tx) => {
        const created = await tx.refund.create({
          data: {
            paymentId: payment.id,
            orderId: payment.orderId,
            currency: payment.currency,
            amountMinor,
            status: RefundStatus.PENDING,
            reason: dto.reason,
            requestedByUserId: this.userId(actor),
            idempotencyKey,
          },
          select: { id: true },
        });

        await tx.order.update({
          where: { id: payment.orderId },
          data: { paymentStatus: PaymentStatus.REFUND_PENDING },
        });

        return created;
      })
      .catch((error: unknown) => {
        // A racing request with the same key lost — return the winner's refund.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          return this.prisma.refund.findUniqueOrThrow({
            where: { idempotencyKey },
            select: { id: true },
          });
        }
        throw error;
      });

    // Ask the gateway outside the transaction. Completion is asynchronous.
    const result = await this.gateway.refund({
      refundId: refund.id,
      gatewayPaymentId: payment.gatewayPaymentId,
      amountMinor,
      currency: 'SAR',
      reason: dto.reason,
      idempotencyKey,
    });

    return this.prisma.refund.update({
      where: { id: refund.id },
      data: {
        gatewayRefundId: result.gatewayRefundId,
        gatewayReference: result.gatewayReference,
        // Accepted by the gateway; still not money-in-hand until confirmed.
        status: RefundStatus.PROCESSING,
      },
      select: refundView,
    });
  }

  // ===========================================================================
  // Webhook application (called by PaymentsService within its transaction)
  // ===========================================================================

  /**
   * Applies a verified refund event to the refund, its payment and the order.
   * Runs inside the webhook's transaction so the whole effect is atomic and,
   * through the refund's status guard, idempotent.
   */
  async applyRefundEvent(
    tx: Prisma.TransactionClient,
    event: ParsedWebhookEvent,
  ): Promise<{ outcome: 'processed' | 'duplicate' | 'unmatched'; orderId?: string }> {
    const refund = await tx.refund.findFirst({
      where: { gatewayRefundId: event.gatewayRefundId },
      select: { id: true, paymentId: true, orderId: true, amountMinor: true, status: true },
    });

    if (!refund) {
      return { outcome: 'unmatched' };
    }

    if (refund.status === RefundStatus.COMPLETED || refund.status === RefundStatus.FAILED) {
      return { outcome: 'duplicate', orderId: refund.orderId };
    }

    if (event.status === 'SUCCEEDED') {
      const payment = await tx.payment.findUniqueOrThrow({
        where: { id: refund.paymentId },
        select: { capturedAmountMinor: true, refundedAmountMinor: true },
      });

      // Defensive cap: never let the recorded refunded total exceed what was
      // captured, even if two refunds settle close together.
      const newRefunded = Math.min(
        payment.refundedAmountMinor + refund.amountMinor,
        payment.capturedAmountMinor,
      );
      const fullyRefunded = newRefunded >= payment.capturedAmountMinor;
      const moneyStatus = fullyRefunded ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED;

      await tx.refund.update({
        where: { id: refund.id },
        data: { status: RefundStatus.COMPLETED, completedAt: new Date() },
      });

      await tx.payment.update({
        where: { id: refund.paymentId },
        data: { refundedAmountMinor: newRefunded, status: moneyStatus },
      });

      await tx.order.update({
        where: { id: refund.orderId },
        data: { paymentStatus: moneyStatus },
      });

      return { outcome: 'processed', orderId: refund.orderId };
    }

    if (event.status === 'FAILED' || event.status === 'CANCELLED') {
      await tx.refund.update({
        where: { id: refund.id },
        data: {
          status: RefundStatus.FAILED,
          failedAt: new Date(),
          failureReason: event.failureReason ?? 'The gateway did not complete the refund.',
        },
      });

      // Restore the order's money state to reflect what actually refunded.
      const payment = await tx.payment.findUniqueOrThrow({
        where: { id: refund.paymentId },
        select: { refundedAmountMinor: true },
      });
      const restored =
        payment.refundedAmountMinor > 0 ? PaymentStatus.PARTIALLY_REFUNDED : PaymentStatus.PAID;

      await tx.order.update({
        where: { id: refund.orderId },
        data: { paymentStatus: restored },
      });

      return { outcome: 'processed', orderId: refund.orderId };
    }

    return { outcome: 'processed', orderId: refund.orderId };
  }

  // ===========================================================================
  // Staff reads
  // ===========================================================================

  async listForStaff(actor: Actor, query: ListRefundsQueryDto) {
    const where: Prisma.RefundWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.orderId ? { orderId: query.orderId } : {}),
      order: { deletedAt: null, ...resolveRequestedBranches(actor, query.branchId) },
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.refund.findMany({
        where,
        select: {
          ...refundView,
          order: { select: { orderNumber: true, referenceId: true, branchId: true } },
        },
        orderBy: { requestedAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.refund.count({ where }),
    ]);

    return { data, meta: buildPaginationMeta(total, query) };
  }

  async getForStaff(actor: Actor, id: string) {
    const refund = await this.prisma.refund.findFirst({
      where: { id },
      select: {
        ...refundView,
        order: { select: { orderNumber: true, referenceId: true, branchId: true } },
      },
    });

    if (!refund) {
      throw new NotFoundException('Refund not found.');
    }

    assertBranchAccess(actor, refund.order.branchId);

    return refund;
  }

  private userId(actor: Actor): string | null {
    return isStaff(actor) ? actor.id : null;
  }
}
