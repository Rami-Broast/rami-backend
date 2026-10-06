import { Injectable, NotFoundException } from '@nestjs/common';

import { Minor } from '../common/money';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePromotionDto, UpdatePromotionDto } from './dto/promotion.dto';
import {
  AppliedPromotion,
  PromotionCartLine,
  PromotionInput,
  selectBestPromotion,
} from './promotion-evaluation';

export interface PromotionEvaluationParams {
  branchId: string;
  /** The cart's lines, with the gross the pricing engine itself computed. */
  lines: readonly PromotionCartLine[];
  /** Gross item total before discount. */
  subtotalMinor: Minor;
  deliveryFeeMinor: Minor;
}

@Injectable()
export class PromotionsService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly includeItems = { items: { include: { product: true } } };

  async list() {
    return this.prisma.promotion.findMany({
      where: { deletedAt: null },
      include: this.includeItems,
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
    });
  }

  async findById(id: string) {
    const promo = await this.prisma.promotion.findUnique({
      where: { id },
      include: this.includeItems,
    });
    if (!promo || promo.deletedAt) throw new NotFoundException('Promotion not found.');
    return promo;
  }

  async create(dto: CreatePromotionDto) {
    const { productIds, ...data } = dto;
    return this.prisma.promotion.create({
      data: {
        name: data.name,
        nameAr: data.nameAr,
        description: data.description,
        descriptionAr: data.descriptionAr,
        imageUrl: data.imageUrl,
        discountType: data.discountType,
        discountValue: data.discountValue,
        maxDiscountMinor: data.maxDiscountMinor,
        branchIds: data.branchIds ?? [],
        startsAt: new Date(data.startsAt),
        endsAt: new Date(data.endsAt),
        priority: data.priority ?? 0,
        items: productIds?.length
          ? { create: productIds.map((productId) => ({ productId })) }
          : undefined,
      },
      include: this.includeItems,
    });
  }

  async update(id: string, dto: UpdatePromotionDto) {
    await this.findById(id);

    const { productIds, startsAt, endsAt, ...fields } = dto;

    return this.prisma.$transaction(async (tx) => {
      if (productIds !== undefined) {
        await tx.promotionItem.deleteMany({ where: { promotionId: id } });
        if (productIds.length) {
          await tx.promotionItem.createMany({
            data: productIds.map((productId) => ({ promotionId: id, productId })),
          });
        }
      }

      return tx.promotion.update({
        where: { id },
        data: {
          ...(fields.name !== undefined && { name: fields.name }),
          ...(fields.nameAr !== undefined && { nameAr: fields.nameAr }),
          ...(fields.description !== undefined && { description: fields.description }),
          ...(fields.descriptionAr !== undefined && { descriptionAr: fields.descriptionAr }),
          ...(fields.imageUrl !== undefined && { imageUrl: fields.imageUrl }),
          ...(fields.discountType !== undefined && { discountType: fields.discountType }),
          ...(fields.discountValue !== undefined && { discountValue: fields.discountValue }),
          ...(fields.maxDiscountMinor !== undefined && {
            maxDiscountMinor: fields.maxDiscountMinor,
          }),
          ...(fields.branchIds !== undefined && { branchIds: fields.branchIds }),
          ...(startsAt !== undefined && { startsAt: new Date(startsAt) }),
          ...(endsAt !== undefined && { endsAt: new Date(endsAt) }),
          ...(fields.priority !== undefined && { priority: fields.priority }),
          ...(fields.isActive !== undefined && { isActive: fields.isActive }),
        },
        include: this.includeItems,
      });
    });
  }

  async publish(id: string) {
    await this.findById(id);
    return this.prisma.promotion.update({
      where: { id },
      data: { isActive: true },
      include: this.includeItems,
    });
  }

  async unpublish(id: string) {
    await this.findById(id);
    return this.prisma.promotion.update({
      where: { id },
      data: { isActive: false },
      include: this.includeItems,
    });
  }

  async remove(id: string) {
    await this.findById(id);
    return this.prisma.promotion.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  async listActive(branchId?: string) {
    const now = new Date();
    const promos = await this.prisma.promotion.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        startsAt: { lte: now },
        endsAt: { gt: now },
      },
      include: {
        items: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                nameAr: true,
                imageUrl: true,
                basePriceMinor: true,
                isActive: true,
              },
            },
          },
        },
      },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
    });

    if (!branchId) return promos;

    return promos.filter((p) => p.branchIds.length === 0 || p.branchIds.includes(branchId));
  }

  /**
   * The promotion that applies to this cart, or null.
   *
   * Mirrors `CouponsService.evaluate`: this method supplies the database facts,
   * the pure {@link selectBestPromotion} decides. The difference is that nothing
   * here throws — a promotion nobody asked for cannot fail, it simply does not
   * apply, and a checkout must never break because a standing offer did not fit
   * the basket.
   */
  async evaluateForCart(params: PromotionEvaluationParams): Promise<AppliedPromotion | null> {
    const now = new Date();

    // Narrowed in SQL to what could possibly apply — active, inside its window,
    // not deleted. Branch and product qualification is decided by the pure
    // function, where it is testable; `branchIds` is an array column and an
    // empty one means "every branch", which is a filter better written in
    // TypeScript than in Prisma's array operators.
    const rows = await this.prisma.promotion.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        startsAt: { lte: now },
        endsAt: { gt: now },
      },
      select: {
        id: true,
        name: true,
        discountType: true,
        discountValue: true,
        maxDiscountMinor: true,
        branchIds: true,
        startsAt: true,
        endsAt: true,
        isActive: true,
        priority: true,
        items: { select: { productId: true } },
      },
    });

    const promotions: PromotionInput[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      discountType: row.discountType,
      discountValue: row.discountValue,
      maxDiscountMinor: row.maxDiscountMinor,
      branchIds: row.branchIds,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      isActive: row.isActive,
      priority: row.priority,
      productIds: row.items.map((item) => item.productId),
    }));

    return selectBestPromotion(promotions, {
      branchId: params.branchId,
      lines: params.lines,
      subtotalMinor: params.subtotalMinor,
      deliveryFeeMinor: params.deliveryFeeMinor,
      now,
    });
  }
}
