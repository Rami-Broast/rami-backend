import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrderEditAction, OrderStatus, Prisma } from '@prisma/client';

import { Actor, isStaff } from '../auth/types/actor';
import { assertBranchAccess } from '../branches/branch-scope';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateOrderItemDto } from './dto/order-edit.dto';

/**
 * Order-edit history and item corrections (spec §32).
 *
 * Two entry points:
 * - `updateItem` — staff correction to an existing item's quantity/notes.
 *   Only allowed while the order is in a pre-shipping status; refuses to
 *   modify orders that are already out for delivery or beyond. Records
 *   an OrderEdit with the before/after snapshot in the same transaction as
 *   the item update, so the audit trail cannot lag the change.
 * - `listEdits` — read-only history for the admin drill-down.
 *
 * Deferred to a follow-up (marked in the reason string on affected edits):
 *   - Automatic reprice: today the item's `unitPriceMinor` is snapshotted
 *     and stays fixed, and the item's `lineTotalMinor` is recomputed as
 *     `unitPriceMinor * newQuantity` without proportionally re-splitting
 *     VAT or the order-level totals. The order totals column will drift
 *     from item lines after an edit and must be reconciled before payment
 *     movement (a partial refund on a lower total or a top-up on a higher
 *     one). Flagged in ARCHITECTURE.md when the money-side lands.
 *   - Adding or removing an item post-placement — same reason.
 */
@Injectable()
export class OrderEditsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Statuses where a staff item edit is still meaningful. */
  private static readonly EDITABLE_STATUSES: OrderStatus[] = [
    OrderStatus.AWAITING_ACCEPTANCE,
    OrderStatus.CONFIRMED,
    OrderStatus.PREPARING,
  ];

  async updateItem(actor: Actor, orderId: string, itemId: string, dto: UpdateOrderItemDto) {
    if (!isStaff(actor)) {
      throw new ForbiddenException('Only staff can edit an order.');
    }

    const order = await this.prisma.order.findFirst({
      where: { id: orderId, deletedAt: null },
      select: {
        id: true,
        branchId: true,
        status: true,
        items: { where: { id: itemId }, select: itemSelect },
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found.');
    }

    // Branch scope: BRANCH_ADMIN can only touch orders at their branches.
    assertBranchAccess(actor, order.branchId);

    if (!OrderEditsService.EDITABLE_STATUSES.includes(order.status)) {
      throw new BadRequestException(
        `Order cannot be edited while status is ${order.status}. Editing is only allowed pre-shipping.`,
      );
    }

    const item = order.items[0];
    if (!item) {
      throw new NotFoundException('Item not found on this order.');
    }

    const previous = {
      quantity: item.quantity,
      notes: item.notes,
      lineSubtotalMinor: item.lineSubtotalMinor,
      lineTotalMinor: item.lineTotalMinor,
    };

    // Simple reprice on the item only (see class doc — the order totals are
    // NOT recomputed here; that's a follow-up on the money side). We keep the
    // per-item invariants consistent so a follow-up can build on top.
    const newSubtotalMinor = item.unitPriceMinor * dto.quantity;
    // Keep the per-line VAT proportion the item was placed with, so a demo
    // reader isn't looking at a zero-VAT line after a quantity edit. Rounded
    // to the nearest halala; the order-level reconciliation follow-up will
    // recompute this properly.
    const ratio = item.lineSubtotalMinor > 0 ? item.lineVatMinor / item.lineSubtotalMinor : 0;
    const newVatMinor = Math.round(newSubtotalMinor * ratio);
    const newTotalMinor = newSubtotalMinor + newVatMinor - item.lineDiscountMinor;

    const nextNotes = dto.notes !== undefined ? dto.notes : item.notes;

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.orderItem.update({
        where: { id: itemId },
        data: {
          quantity: dto.quantity,
          notes: nextNotes,
          lineSubtotalMinor: newSubtotalMinor,
          lineVatMinor: newVatMinor,
          lineTotalMinor: newTotalMinor,
        },
        select: itemSelect,
      });

      await tx.orderEdit.create({
        data: {
          orderId,
          orderItemId: itemId,
          editedByUserId: actor.id,
          action:
            dto.notes !== undefined && dto.quantity === item.quantity
              ? OrderEditAction.UPDATE_ITEM_NOTES
              : OrderEditAction.UPDATE_ITEM_QUANTITY,
          reason: dto.reason,
          snapshotBefore: previous,
          snapshotAfter: {
            quantity: updated.quantity,
            notes: updated.notes,
            lineSubtotalMinor: updated.lineSubtotalMinor,
            lineTotalMinor: updated.lineTotalMinor,
          },
        },
      });

      return updated;
    });
  }

  async listEdits(actor: Actor, orderId: string) {
    if (!isStaff(actor)) {
      throw new ForbiddenException('Only staff can view an order’s edit history.');
    }

    const order = await this.prisma.order.findFirst({
      where: { id: orderId, deletedAt: null },
      select: { id: true, branchId: true },
    });

    if (!order) {
      throw new NotFoundException('Order not found.');
    }

    assertBranchAccess(actor, order.branchId);

    return this.prisma.orderEdit.findMany({
      where: { orderId },
      select: {
        id: true,
        action: true,
        reason: true,
        snapshotBefore: true,
        snapshotAfter: true,
        createdAt: true,
        orderItemId: true,
        editedByUser: { select: { id: true, email: true, fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}

const itemSelect = {
  id: true,
  orderId: true,
  productId: true,
  productVariantId: true,
  productName: true,
  variantName: true,
  taxClass: true,
  unitPriceMinor: true,
  quantity: true,
  lineSubtotalMinor: true,
  lineDiscountMinor: true,
  lineVatMinor: true,
  lineTotalMinor: true,
  notes: true,
} satisfies Prisma.OrderItemSelect;
