import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { buildPaginationMeta, PaginationQueryDto } from '../common/dto/pagination.dto';
import { PrismaService } from '../prisma/prisma.service';
import { ResolvedDiscount } from '../vat/pricing.types';
import { CouponContext, evaluateCoupon } from './coupon-evaluation';
import { CreateCouponDto, UpdateCouponDto } from './dto/coupon.dto';

export interface CouponEvaluationParams {
  code: string;
  customerId: string;
  branchId: string;
  subtotalMinor: number;
  deliveryFeeMinor: number;
  productIds: readonly string[];
}

/** The MIN_SPEND rule's threshold, when the coupon carries one. */
function minSpendOf(rules: readonly { ruleType: string; config: unknown }[]): number | undefined {
  const rule = rules.find((r) => r.ruleType === 'MIN_SPEND');
  const config = rule?.config;
  const value =
    config && typeof config === 'object'
      ? (config as Record<string, unknown>).minSpendMinor
      : undefined;

  return typeof value === 'number' ? value : undefined;
}

export interface AppliedCoupon {
  couponId: string;
  /**
   * The coupon's own name — "Twenty off your first order".
   *
   * Carried so a client can say *which* offer took money off the bill. A code
   * alone ("SAVE20 applied") is a receipt for something the customer has to
   * remember; the name is what they chose on the Offers page.
   */
  name: string;
  discountMinor: number;
  discount: ResolvedDiscount;
}

/**
 * Coupons (Phase 17).
 *
 * Validation is a pure function ({@link evaluateCoupon}); this service supplies
 * it the database facts it needs — usage counts, whether it's a first order, the
 * cart's categories — and turns a valid coupon into a discount the VAT engine
 * applies. A coupon never touches tax arithmetic itself.
 *
 * Reuse prevention is atomic and lives in the database: `CouponUsage.orderId` is
 * unique, and the total-usage-limit guard is a conditional increment, so two
 * concurrent checkouts cannot both consume the last use of a coupon.
 */
@Injectable()
export class CouponsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Evaluates a coupon code against a cart for a customer, returning the
   * discount to apply, or throwing a specific reason it cannot be used.
   */
  async evaluate(params: CouponEvaluationParams): Promise<AppliedCoupon> {
    const coupon = await this.prisma.coupon.findFirst({
      where: { code: params.code, deletedAt: null },
      include: { rules: true },
    });

    if (!coupon) {
      throw new BadRequestException('That coupon code is not valid.');
    }

    const [priorOrders, customerUsageCount, cartProducts] = await Promise.all([
      this.prisma.order.count({ where: { customerId: params.customerId } }),
      this.prisma.couponUsage.count({
        where: { couponId: coupon.id, customerId: params.customerId },
      }),
      this.prisma.product.findMany({
        where: { id: { in: [...params.productIds] } },
        select: { categoryId: true },
      }),
    ]);

    const context: CouponContext = {
      customerId: params.customerId,
      branchId: params.branchId,
      subtotalMinor: params.subtotalMinor,
      deliveryFeeMinor: params.deliveryFeeMinor,
      productIds: params.productIds,
      categoryIds: [...new Set(cartProducts.map((p) => p.categoryId))],
      isFirstOrder: priorOrders === 0,
      customerUsageCount,
      now: new Date(),
    };

    const result = evaluateCoupon(
      {
        code: coupon.code,
        discountType: coupon.discountType,
        discountValue: coupon.discountValue,
        maxDiscountMinor: coupon.maxDiscountMinor,
        validFrom: coupon.validFrom,
        validUntil: coupon.validUntil,
        isActive: coupon.isActive,
        totalUsageLimit: coupon.totalUsageLimit,
        perCustomerLimit: coupon.perCustomerLimit,
        usageCount: coupon.usageCount,
      },
      coupon.rules,
      context,
    );

    if (!result.ok) {
      throw new BadRequestException(result.reason);
    }

    return {
      couponId: coupon.id,
      name: coupon.name,
      discountMinor: result.discountMinor,
      discount: result.discount,
    };
  }

  /**
   * Records that a coupon was consumed by an order, inside the order-creation
   * transaction. The conditional increment enforces the total usage limit
   * atomically; the unique `orderId` prevents a coupon being consumed twice by
   * the same order.
   */
  async recordUsage(
    tx: Prisma.TransactionClient,
    couponId: string,
    customerId: string,
    orderId: string,
    discountAppliedMinor: number,
  ): Promise<void> {
    // Atomically claim one use: only increments while under the limit (or when
    // there is no limit). Zero rows updated means the coupon was exhausted
    // between evaluation and now.
    const claimed = await tx.coupon.updateMany({
      where: {
        id: couponId,
        OR: [
          { totalUsageLimit: null },
          { usageCount: { lt: this.prisma.coupon.fields.totalUsageLimit } },
        ],
      },
      data: { usageCount: { increment: 1 } },
    });

    if (claimed.count === 0) {
      throw new ConflictException('This coupon has just reached its usage limit.');
    }

    await tx.couponUsage.create({
      data: { couponId, customerId, orderId, discountAppliedMinor },
    });
  }

  // --- Admin -----------------------------------------------------------------

  async create(dto: CreateCouponDto) {
    const validFrom = new Date(dto.validFrom);
    const validUntil = new Date(dto.validUntil);

    if (Number.isNaN(validFrom.getTime()) || Number.isNaN(validUntil.getTime())) {
      throw new BadRequestException('validFrom and validUntil must be valid dates.');
    }
    if (validUntil <= validFrom) {
      throw new BadRequestException('validUntil must be after validFrom.');
    }

    try {
      return await this.prisma.coupon.create({
        data: {
          code: dto.code,
          name: dto.name,
          description: dto.description,
          discountType: dto.discountType,
          discountValue: new Prisma.Decimal(dto.discountValue),
          maxDiscountMinor: dto.maxDiscountMinor ?? null,
          validFrom,
          validUntil,
          totalUsageLimit: dto.totalUsageLimit ?? null,
          perCustomerLimit: dto.perCustomerLimit ?? null,
          isPublic: dto.isPublic ?? false,
          imageUrl: dto.imageUrl ?? null,
          rules: dto.rules
            ? {
                create: dto.rules.map((rule) => ({
                  ruleType: rule.ruleType,
                  config: rule.config as Prisma.InputJsonValue,
                })),
              }
            : undefined,
        },
        include: { rules: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('A coupon with that code already exists.');
      }
      throw error;
    }
  }

  async list(query: PaginationQueryDto) {
    const where = { deletedAt: null };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.coupon.findMany({
        where,
        include: { rules: true, _count: { select: { usages: true } } },
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.coupon.count({ where }),
    ]);
    return { data, meta: buildPaginationMeta(total, query) };
  }

  /**
   * Changes what an offer *looks like* and whether it is on sale — never its
   * terms. See {@link UpdateCouponDto}: the code, discount, dates and limits are
   * what customers were promised and what past redemptions were made under.
   *
   * Every field is applied only when the caller sent it, so unticking nothing
   * cannot silently clear the artwork — the bug that made a sold-out toggle
   * erase a branch's price.
   */
  async update(id: string, dto: UpdateCouponDto) {
    await this.get(id);

    return this.prisma.coupon.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.isPublic !== undefined && { isPublic: dto.isPublic }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        ...(dto.imageUrl !== undefined && { imageUrl: dto.imageUrl }),
      },
      include: { rules: true, _count: { select: { usages: true } } },
    });
  }

  /**
   * The offers the customer app shows: coupons the owner published.
   *
   * Four things have to be true at once, and each one is a way a customer ends
   * up staring at a code the checkout then rejects: the owner published it, it
   * is active, today is inside its window, and it has redemptions left. An
   * exhausted or expired offer is not shown at all rather than shown and
   * refused.
   *
   * Nothing private leaks: `isPublic` is off by default, so a targeted or
   * single-customer coupon is never listed by omission — only by an owner
   * deliberately ticking the box.
   */
  async listPublic(now: Date = new Date()) {
    const coupons = await this.prisma.coupon.findMany({
      where: {
        deletedAt: null,
        isPublic: true,
        isActive: true,
        validFrom: { lte: now },
        validUntil: { gte: now },
      },
      include: { rules: true },
      orderBy: [{ validUntil: 'asc' }, { createdAt: 'desc' }],
    });

    return coupons
      .filter((c) => c.totalUsageLimit === null || c.usageCount < c.totalUsageLimit)
      .map((coupon) => ({
        id: coupon.id,
        code: coupon.code,
        name: coupon.name,
        description: coupon.description ?? undefined,
        imageUrl: coupon.imageUrl ?? undefined,
        discountType: coupon.discountType,
        discountValue: Number(coupon.discountValue),
        maxDiscountMinor: coupon.maxDiscountMinor ?? undefined,
        // Surfaced so the card can say "on orders over SAR 50" instead of
        // letting the customer discover the condition when it is refused.
        minSpendMinor: minSpendOf(coupon.rules),
        validUntil: coupon.validUntil.toISOString(),
      }));
  }

  async get(id: string) {
    const coupon = await this.prisma.coupon.findFirst({
      where: { id, deletedAt: null },
      include: { rules: true, _count: { select: { usages: true } } },
    });
    if (!coupon) {
      throw new NotFoundException('Coupon not found.');
    }
    return coupon;
  }
}
