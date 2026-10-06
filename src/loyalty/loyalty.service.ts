import { Injectable, Logger } from '@nestjs/common';
import { LoyaltyTransactionType, Prisma } from '@prisma/client';

import { Actor, isStaff } from '../auth/types/actor';
import { AppConfigService } from '../config/app-config.service';
import { buildPaginationMeta, PaginationQueryDto } from '../common/dto/pagination.dto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Loyalty (Phase 17).
 *
 * A points **ledger**, never a stored balance — the balance is `SUM(points)`
 * over an account's append-only transactions, so there is no counter to drift
 * from the entries that justify it (the schema deliberately omits a balance
 * column).
 *
 * Points are earned when an order is delivered and reversed when it is cancelled
 * or refunded — the specification requires that refunds/cancellations reverse
 * points, and reversal is proportional to what was refunded. The earn *rate* is
 * a business decision (`LOYALTY_POINTS_PER_SAR`, default 1, to be confirmed
 * before launch), not invented here.
 *
 * Earn/reverse are called after the triggering operation has committed and are
 * best-effort: a loyalty failure is logged, never allowed to break an order or a
 * payment.
 */
@Injectable()
export class LoyaltyService {
  private readonly logger = new Logger(LoyaltyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  /** Points earned for a given order total, per the configured rate. */
  private pointsForTotal(totalMinor: number): number {
    const wholeSar = Math.floor(totalMinor / 100);
    return wholeSar * this.config.loyalty.pointsPerSar;
  }

  private async accountId(
    tx: Prisma.TransactionClient | PrismaService,
    customerId: string,
  ): Promise<string> {
    const account = await tx.loyaltyAccount.upsert({
      where: { customerId },
      update: {},
      create: { customerId },
      select: { id: true },
    });
    return account.id;
  }

  /**
   * Earns points for a delivered order. Idempotent: an order that has already
   * earned does not earn again.
   */
  async earnForOrder(orderId: string): Promise<void> {
    try {
      const order = await this.prisma.order.findFirst({
        where: { id: orderId },
        select: { id: true, customerId: true, totalMinor: true },
      });
      if (!order) {
        return;
      }

      const already = await this.prisma.loyaltyTransaction.findFirst({
        where: { orderId, type: LoyaltyTransactionType.EARN },
        select: { id: true },
      });
      if (already) {
        return;
      }

      const points = this.pointsForTotal(order.totalMinor);
      if (points <= 0) {
        return;
      }

      const loyaltyAccountId = await this.accountId(this.prisma, order.customerId);
      await this.prisma.loyaltyTransaction.create({
        data: {
          loyaltyAccountId,
          type: LoyaltyTransactionType.EARN,
          points,
          orderId,
          reason: 'Order delivered',
        },
      });
    } catch (error) {
      this.logger.warn(`Loyalty earn failed for order ${orderId}: ${(error as Error).message}`);
    }
  }

  /** Reverses all net points earned for an order (e.g. on cancellation). */
  async reverseAllForOrder(orderId: string, reason: string): Promise<void> {
    await this.reverseTo(orderId, 1, reason);
  }

  /**
   * Reverses points in proportion to how much of the order has been refunded.
   * Idempotent and monotonic: a later, larger refund reverses only the
   * difference, so partial-then-full refunding reverses exactly the earned
   * points once.
   */
  async reverseForRefund(orderId: string): Promise<void> {
    try {
      const payments = await this.prisma.payment.findMany({
        where: { orderId },
        select: { capturedAmountMinor: true, refundedAmountMinor: true },
      });
      const captured = payments.reduce((sum, p) => sum + p.capturedAmountMinor, 0);
      const refunded = payments.reduce((sum, p) => sum + p.refundedAmountMinor, 0);
      if (captured <= 0) {
        return;
      }
      const fraction = Math.min(refunded / captured, 1);
      await this.reverseTo(orderId, fraction, 'Order refunded');
    } catch (error) {
      this.logger.warn(
        `Loyalty reverse (refund) failed for ${orderId}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Ensures the reversed points for an order reach `fraction` of what was
   * earned, creating a REVERSE entry for the remaining difference only.
   */
  private async reverseTo(orderId: string, fraction: number, reason: string): Promise<void> {
    try {
      const [earnAgg, reverseAgg] = await Promise.all([
        this.prisma.loyaltyTransaction.aggregate({
          where: { orderId, type: LoyaltyTransactionType.EARN },
          _sum: { points: true },
        }),
        this.prisma.loyaltyTransaction.aggregate({
          where: { orderId, type: LoyaltyTransactionType.REVERSE },
          _sum: { points: true },
        }),
      ]);

      const earned = earnAgg._sum.points ?? 0;
      if (earned <= 0) {
        return;
      }
      // REVERSE points are stored negative; already-reversed is their magnitude.
      const alreadyReversed = -(reverseAgg._sum.points ?? 0);
      const target = Math.floor(earned * fraction);
      const delta = target - alreadyReversed;
      if (delta <= 0) {
        return;
      }

      const order = await this.prisma.order.findFirst({
        where: { id: orderId },
        select: { customerId: true },
      });
      if (!order) {
        return;
      }

      const loyaltyAccountId = await this.accountId(this.prisma, order.customerId);
      await this.prisma.loyaltyTransaction.create({
        data: {
          loyaltyAccountId,
          type: LoyaltyTransactionType.REVERSE,
          points: -delta,
          orderId,
          reason,
        },
      });
    } catch (error) {
      this.logger.warn(`Loyalty reverse failed for order ${orderId}: ${(error as Error).message}`);
    }
  }

  // --- Reads and admin -------------------------------------------------------

  /** The customer's current points balance: the sum of their ledger. */
  async balance(customerId: string): Promise<number> {
    const account = await this.prisma.loyaltyAccount.findUnique({
      where: { customerId },
      select: { id: true },
    });
    if (!account) {
      return 0;
    }
    const agg = await this.prisma.loyaltyTransaction.aggregate({
      where: { loyaltyAccountId: account.id },
      _sum: { points: true },
    });
    return agg._sum.points ?? 0;
  }

  async ledger(customerId: string, query: PaginationQueryDto) {
    const account = await this.prisma.loyaltyAccount.findUnique({
      where: { customerId },
      select: { id: true },
    });
    if (!account) {
      return { balance: 0, data: [], meta: buildPaginationMeta(0, query) };
    }

    const where = { loyaltyAccountId: account.id };
    const [data, total, agg] = await this.prisma.$transaction([
      this.prisma.loyaltyTransaction.findMany({
        where,
        select: {
          id: true,
          type: true,
          points: true,
          orderId: true,
          reason: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.loyaltyTransaction.count({ where }),
      this.prisma.loyaltyTransaction.aggregate({ where, _sum: { points: true } }),
    ]);

    return { balance: agg._sum.points ?? 0, data, meta: buildPaginationMeta(total, query) };
  }

  /**
   * A manual adjustment by staff (`loyalty:adjust`). Always a new signed ledger
   * entry, attributed to the actor and audited — never an edit of history.
   */
  async adjust(actor: Actor, customerId: string, points: number, reason: string) {
    const loyaltyAccountId = await this.accountId(this.prisma, customerId);
    return this.prisma.loyaltyTransaction.create({
      data: {
        loyaltyAccountId,
        type: LoyaltyTransactionType.ADJUST,
        points,
        reason,
        createdByUserId: isStaff(actor) ? actor.id : null,
      },
      select: { id: true, type: true, points: true, reason: true, createdAt: true },
    });
  }
}
