import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DeliveryStatus, PaymentMethod, PaymentStatus, Prisma } from '@prisma/client';

import { Actor, ActorKind, isStaff } from '../auth/types/actor';
import { assertBranchAccess, resolveRequestedBranches } from '../branches/branch-scope';
import { buildPaginationMeta } from '../common/dto/pagination.dto';
import { PrismaService } from '../prisma/prisma.service';
import { ZatcaInvoicingService } from '../zatca-invoicing/zatca-invoicing.service';
import { ListCashCollectionsQueryDto, RecordCashCollectedDto } from './dto/cash-collection.dto';

/** The safe view returned to both the driver and staff. */
const cashView = {
  id: true,
  deliveryId: true,
  driverId: true,
  branchId: true,
  expectedMinor: true,
  collectedMinor: true,
  varianceMinor: true,
  note: true,
  collectedByUserId: true,
  createdAt: true,
  driver: {
    select: {
      id: true,
      user: { select: { fullName: true, email: true } },
    },
  },
  branch: { select: { id: true, code: true, name: true } },
  delivery: {
    select: {
      id: true,
      order: { select: { id: true, orderNumber: true, referenceId: true } },
    },
  },
} satisfies Prisma.CashCollectionSelect;

/**
 * Cash-on-delivery reconciliation.
 *
 * One row per delivery: the driver reports what they actually took, and the
 * service records the variance against the payment we expected. Immutable —
 * a mistyped amount cannot be edited; the paper record and a follow-up note
 * are the correction path, which is what the finance side expects.
 *
 * Two entry points:
 * - `recordCollected` — the driver's own action (`deliveries:own`). Rejects
 *   any delivery that isn't COD, or that isn't marked delivered, or that
 *   already has a collection row.
 * - `listForStaff` / `getForStaff` — the branch-scoped reconciliation view
 *   (`deliveries:read`). OWNER spans branches, BRANCH_ADMIN sees only theirs.
 */
@Injectable()
export class CashCollectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly zatca: ZatcaInvoicingService,
  ) {}

  async recordCollected(actor: Actor, deliveryId: string, dto: RecordCashCollectedDto) {
    if (!isStaff(actor)) {
      throw new BadRequestException('Only staff can record cash collection.');
    }

    const delivery = await this.prisma.delivery.findFirst({
      where: { id: deliveryId },
      select: {
        id: true,
        branchId: true,
        driverId: true,
        status: true,
        order: {
          select: {
            id: true,
            payments: {
              select: {
                id: true,
                method: true,
                capturedAmountMinor: true,
                amountMinor: true,
              },
            },
          },
        },
      },
    });

    if (!delivery) {
      throw new NotFoundException('Delivery not found.');
    }

    if (delivery.driverId === null) {
      throw new BadRequestException(
        'This delivery is not assigned to a driver — no cash to reconcile.',
      );
    }

    if (delivery.status !== DeliveryStatus.DELIVERED) {
      throw new BadRequestException(
        'Cash can only be recorded after the delivery is marked delivered.',
      );
    }

    // Only the assigned driver may record their own cash; other staff cannot
    // reach this endpoint (it lives on the driver-facing controller).
    if (actor.id !== delivery.driverId) {
      // The driverId column is the Driver.id; the actor is the User.id. Walk
      // one hop to check ownership.
      const driver = await this.prisma.driver.findFirst({
        where: { id: delivery.driverId },
        select: { userId: true },
      });
      if (driver?.userId !== actor.id) {
        throw new BadRequestException(
          'Only the assigned driver may record cash collection for this delivery.',
        );
      }
    }

    const codPayment = delivery.order.payments.find(
      (p) => p.method === PaymentMethod.CASH_ON_DELIVERY,
    );
    if (!codPayment) {
      throw new BadRequestException(
        'This order was not placed as cash on delivery — no cash reconciliation to record.',
      );
    }

    // Prefer the captured amount when the payment was completed; fall back to
    // the total amountMinor otherwise. Either is snapshotted per payment.
    const expectedMinor = codPayment.capturedAmountMinor || codPayment.amountMinor;
    const varianceMinor = dto.collectedMinor - expectedMinor;
    // Bound outside the closure: the null check above narrows `driverId` here
    // but not inside the callback.
    const driverId = delivery.driverId;

    try {
      const record = await this.prisma.$transaction(async (tx) => {
        const created = await tx.cashCollection.create({
          data: {
            deliveryId: delivery.id,
            driverId,
            branchId: delivery.branchId,
            expectedMinor,
            collectedMinor: dto.collectedMinor,
            varianceMinor,
            note: dto.note ?? null,
            collectedByUserId: actor.id,
          },
          select: cashView,
        });

        await this.settleCodPayment(tx, {
          paymentId: codPayment.id,
          orderId: delivery.order.id,
          expectedMinor,
          collectedMinor: dto.collectedMinor,
        });

        return created;
      });

      // Post-commit: once COD cash covers the bill, money is real — issue the
      // ZATCA tax invoice. Best-effort and idempotent (mirrors settleCodPayment's
      // own PAID condition).
      if (dto.collectedMinor >= expectedMinor) {
        await this.zatca.issueInvoiceForOrder(delivery.order.id);
      }

      return record;
    } catch (error) {
      // The unique(deliveryId) index catches a double-submit.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Cash has already been recorded for this delivery.');
      }
      throw error;
    }
  }

  /**
   * Marks the cash-on-delivery payment settled once the driver has handed the
   * money over.
   *
   * Until this existed, nothing ever moved a COD payment off `PENDING`. Only
   * counter cash taken at the till and a verified gateway webhook did, so every
   * COD order stayed unpaid for ever: the payments report showed
   * `capturedMinor: 0` for cash while the sales report showed the full amount
   * for the same period, and the two disagreed permanently. Cash is currently
   * the only payment method that actually works, so that gap covered all real
   * revenue.
   *
   * Two deliberate rules:
   *
   * - **Capture the expected amount, never the collected one.** A driver handed
   *   more than the total — a tip, or change not given — has not increased what
   *   the order was worth, and capturing it would overstate revenue against an
   *   order whose snapshot says otherwise.
   * - **A short collection settles nothing.** The payment stays `PENDING` and
   *   the `CashCollection` row carries the variance for a manager to resolve.
   *   Recording money that was not handed over as received is the one outcome
   *   that must not happen quietly, and what a shortfall *means* — write-off,
   *   driver liability, partial capture — is a business decision this service
   *   must not invent. The record is there either way, so nothing is lost.
   *
   * `Order.status` is untouched: fulfilment and money move independently, and
   * the order is already DELIVERED by the time this runs.
   */
  private async settleCodPayment(
    tx: Prisma.TransactionClient,
    input: { paymentId: string; orderId: string; expectedMinor: number; collectedMinor: number },
  ): Promise<void> {
    if (input.collectedMinor < input.expectedMinor) {
      return;
    }

    await tx.payment.update({
      where: { id: input.paymentId },
      data: {
        status: PaymentStatus.PAID,
        capturedAmountMinor: input.expectedMinor,
        capturedAt: new Date(),
      },
    });

    await tx.order.update({
      where: { id: input.orderId },
      data: { paymentStatus: PaymentStatus.PAID },
    });
  }

  async listForStaff(actor: Actor, query: ListCashCollectionsQueryDto) {
    if (!isStaff(actor)) {
      // deliveries:read isn't granted to non-staff, but defence-in-depth.
      return { data: [], meta: buildPaginationMeta(0, query) };
    }

    if (query.branchId) {
      assertBranchAccess(actor, query.branchId);
    }
    const scope = resolveRequestedBranches(actor, query.branchId);

    const where: Prisma.CashCollectionWhereInput = {
      ...(query.driverId ? { driverId: query.driverId } : {}),
      ...(scope.branchId ? { branchId: scope.branchId } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lt: query.to } : {}),
            },
          }
        : {}),
    };

    const [data, total, aggregate] = await this.prisma.$transaction([
      this.prisma.cashCollection.findMany({
        where,
        select: cashView,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.cashCollection.count({ where }),
      this.prisma.cashCollection.aggregate({
        where,
        _sum: {
          expectedMinor: true,
          collectedMinor: true,
          varianceMinor: true,
        },
      }),
    ]);

    return {
      data,
      meta: buildPaginationMeta(total, query),
      totals: {
        expectedMinor: aggregate._sum.expectedMinor ?? 0,
        collectedMinor: aggregate._sum.collectedMinor ?? 0,
        varianceMinor: aggregate._sum.varianceMinor ?? 0,
      },
    };
  }

  async getForStaff(actor: Actor, id: string) {
    const row = await this.prisma.cashCollection.findFirst({
      where: { id },
      select: cashView,
    });

    if (!row) {
      throw new NotFoundException('Cash collection not found.');
    }

    // Enforce branch scope after the read: same shape as reports.
    if (isStaff(actor) && actor.branchScope.kind === 'ASSIGNED') {
      if (!actor.branchScope.branchIds.includes(row.branchId)) {
        throw new NotFoundException('Cash collection not found.');
      }
    }
    if (actor.kind !== ActorKind.Staff) {
      throw new NotFoundException('Cash collection not found.');
    }

    return row;
  }
}
