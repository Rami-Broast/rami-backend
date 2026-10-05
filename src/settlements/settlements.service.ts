import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  GatewayFeeType,
  PaymentStatus,
  Prisma,
  RefundStatus,
  SettlementStatus,
} from '@prisma/client';

import { Actor } from '../auth/types/actor';
import {
  assertBranchAccess,
  branchScopeFilter,
  resolveRequestedBranches,
} from '../branches/branch-scope';
import { buildPaginationMeta } from '../common/dto/pagination.dto';
import { PrismaService } from '../prisma/prisma.service';
import { IngestPayoutDto, ListSettlementsQueryDto } from './dto/settlement.dto';
import {
  OwnPayment,
  OwnRefund,
  PayoutLine,
  ReconciledLine,
  reconcileSettlement,
} from './settlement-reconciliation';

/** Payment states in which money has actually been captured. */
const CAPTURED_STATUSES: PaymentStatus[] = [
  PaymentStatus.PAID,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
];

/**
 * Settlements and reconciliation (Phase 18).
 *
 * Matches a gateway's payout report against our own money records and records
 * the result — gross sales, refunds, gateway fees, the net we expected and the
 * net the gateway actually paid, with every unmatched, duplicate, missing or
 * unexpected line flagged for human review.
 *
 * The specification's hard rule shapes the whole module: **settlement is never
 * derived from order totals.** Expected net is reconstructed from captured
 * `Payment`s, completed `Refund`s and their recorded gateway fees — the actual
 * money-movement records — and compared against the payout. An order's
 * `totalMinor` is never consulted here; a discount that never reached the
 * gateway, or a fee the gateway took, would both be invisible if we did.
 */
@Injectable()
export class SettlementsService {
  constructor(private readonly prisma: PrismaService) {}

  // ===========================================================================
  // Ingestion and reconciliation
  // ===========================================================================

  /**
   * Ingests a gateway payout report and reconciles it against our records.
   *
   * Idempotent by `(gatewayName, settlementReference)`: a re-submitted payout is
   * rejected rather than double-counted. The whole write — the settlement, its
   * transaction lines and the gateway-fee records — commits in one transaction.
   */
  async ingestPayout(actor: Actor, dto: IngestPayoutDto) {
    const branchId = this.resolveSettlementBranch(actor, dto.branchId);

    const periodStart = new Date(dto.periodStart);
    const periodEnd = new Date(dto.periodEnd);
    if (periodEnd <= periodStart) {
      throw new BadRequestException('periodEnd must be after periodStart.');
    }

    // Reject a re-submission up front for a clear error; the unique constraint is
    // the real guard against a concurrent double-ingest (caught below).
    const existing = await this.prisma.settlement.findUnique({
      where: {
        gatewayName_settlementReference: {
          gatewayName: dto.gatewayName,
          settlementReference: dto.settlementReference,
        },
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException('This settlement reference has already been recorded.');
    }

    const { ownPayments, ownRefunds } = await this.gatherOwnRecords(
      dto.gatewayName,
      branchId,
      periodStart,
      periodEnd,
    );

    const payoutLines: PayoutLine[] = dto.lines.map((line) => ({
      gatewayReference: line.gatewayReference,
      type: line.type,
      amountMinor: line.amountMinor,
      feeMinor: line.feeMinor,
    }));

    const result = reconcileSettlement(payoutLines, ownPayments, ownRefunds);

    const status = result.hasDiscrepancy ? SettlementStatus.DISCREPANCY : SettlementStatus.MATCHED;

    try {
      const settlementId = await this.prisma.$transaction(async (tx) => {
        const settlement = await tx.settlement.create({
          data: {
            gatewayName: dto.gatewayName,
            settlementReference: dto.settlementReference,
            branchId,
            periodStart,
            periodEnd,
            payoutDate: dto.payoutDate ? new Date(dto.payoutDate) : null,
            grossSalesMinor: BigInt(result.grossSalesMinor),
            refundsMinor: BigInt(result.refundsMinor),
            gatewayFeesMinor: BigInt(result.gatewayFeesMinor),
            expectedNetMinor: BigInt(result.expectedNetMinor),
            actualNetMinor: BigInt(result.actualNetMinor),
            varianceMinor: BigInt(result.varianceMinor),
            status,
            matchedAt: new Date(),
            notes: dto.notes,
          },
          select: { id: true },
        });

        for (const line of result.lines) {
          const transaction = await tx.settlementTransaction.create({
            data: {
              settlementId: settlement.id,
              paymentId: line.paymentId,
              refundId: line.refundId,
              amountMinor: line.amountMinor,
              feeMinor: line.feeMinor,
              netMinor: line.netMinor,
              matchStatus: line.matchStatus,
              gatewayReference: line.gatewayReference,
              notes: line.notes,
            },
            select: { id: true },
          });

          if (line.feeMinor > 0) {
            await tx.gatewayFee.create({
              data: {
                gatewayName: dto.gatewayName,
                feeType: this.feeTypeFor(line),
                feeMinor: line.feeMinor,
                paymentId: line.paymentId,
                refundId: line.refundId,
                settlementTransactionId: transaction.id,
                description: `Settlement ${dto.settlementReference}`,
              },
            });
          }
        }

        return settlement.id;
      });

      return this.getForStaff(actor, settlementId);
    } catch (error) {
      // A concurrent ingest of the same reference lost the race.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('This settlement reference has already been recorded.');
      }
      throw error;
    }
  }

  // ===========================================================================
  // Staff reads
  // ===========================================================================

  async listForStaff(actor: Actor, query: ListSettlementsQueryDto) {
    const where: Prisma.SettlementWhereInput = {
      ...this.settlementBranchFilter(actor, query.branchId),
      ...(query.status ? { status: query.status } : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.settlement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.settlement.count({ where }),
    ]);

    return { data: data.map((s) => this.serialize(s)), meta: buildPaginationMeta(total, query) };
  }

  async getForStaff(actor: Actor, id: string) {
    const settlement = await this.prisma.settlement.findFirst({
      where: { id },
      include: { transactions: { orderBy: { createdAt: 'asc' } } },
    });

    if (!settlement) {
      throw new NotFoundException('Settlement not found.');
    }

    // Branch isolation: an org-wide settlement (no branch) is owner-only; a
    // branch-scoped one is reachable by staff assigned to that branch.
    if (settlement.branchId === null) {
      this.assertOrgWideAccess(actor);
    } else {
      assertBranchAccess(actor, settlement.branchId);
    }

    return this.serialize(settlement);
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  /** Resolves and access-checks the branch a new settlement is scoped to. */
  private resolveSettlementBranch(actor: Actor, branchId: string | undefined): string | null {
    if (branchId === undefined) {
      // An organisation-wide settlement spans every branch — owners only.
      this.assertOrgWideAccess(actor);
      return null;
    }

    assertBranchAccess(actor, branchId);
    return branchId;
  }

  /** Only an actor with organisation-wide reach may touch an unscoped settlement. */
  private assertOrgWideAccess(actor: Actor): void {
    if (actor.branchScope.kind !== 'ALL') {
      throw new BadRequestException(
        'An organisation-wide settlement is owner-only. Specify a branchId.',
      );
    }
  }

  /** A `where` fragment scoping settlement reads to what the actor may reach. */
  private settlementBranchFilter(
    actor: Actor,
    requestedBranchId: string | undefined,
  ): Prisma.SettlementWhereInput {
    if (actor.branchScope.kind === 'ALL') {
      // An owner sees org-wide settlements and any branch's; an owner may also
      // filter to one branch.
      return requestedBranchId ? { branchId: requestedBranchId } : {};
    }

    // Branch staff: only their own branches' settlements, never the org-wide
    // ones. `branchScopeFilter` already restricts to assigned branches, and
    // `resolveRequestedBranches` validates a named branch against that scope.
    const scope = resolveRequestedBranches(actor, requestedBranchId);
    return { branchId: scope.branchId ?? branchScopeFilter(actor).branchId };
  }

  /**
   * Gathers our own captured payments and completed refunds for the payout's
   * gateway, period and branch scope — the records the payout is checked
   * against. Read from money records only, never from order totals.
   */
  private async gatherOwnRecords(
    gatewayName: string,
    branchId: string | null,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<{ ownPayments: OwnPayment[]; ownRefunds: OwnRefund[] }> {
    const orderBranchFilter = branchId ? { branchId } : {};

    const payments = await this.prisma.payment.findMany({
      where: {
        gatewayName,
        gatewayPaymentId: { not: null },
        status: { in: CAPTURED_STATUSES },
        capturedAt: { gte: periodStart, lte: periodEnd },
        order: orderBranchFilter,
      },
      select: {
        id: true,
        gatewayPaymentId: true,
        capturedAmountMinor: true,
        gatewayFeeMinor: true,
      },
    });

    const refunds = await this.prisma.refund.findMany({
      where: {
        status: RefundStatus.COMPLETED,
        gatewayRefundId: { not: null },
        completedAt: { gte: periodStart, lte: periodEnd },
        payment: { gatewayName },
        order: orderBranchFilter,
      },
      select: { id: true, gatewayRefundId: true, amountMinor: true },
    });

    const ownPayments: OwnPayment[] = payments.map((p) => ({
      paymentId: p.id,
      gatewayReference: p.gatewayPaymentId as string,
      capturedAmountMinor: p.capturedAmountMinor,
      feeMinor: p.gatewayFeeMinor ?? 0,
    }));

    const ownRefunds: OwnRefund[] = refunds.map((r) => ({
      refundId: r.id,
      gatewayReference: r.gatewayRefundId as string,
      amountMinor: r.amountMinor,
    }));

    return { ownPayments, ownRefunds };
  }

  private feeTypeFor(line: ReconciledLine): GatewayFeeType {
    return line.type === 'REFUND' ? GatewayFeeType.REFUND : GatewayFeeType.TRANSACTION;
  }

  /**
   * Converts a settlement's BigInt aggregates to strings for transport. Money
   * crosses the API as strings — the same choice made for Decimal — so a value
   * that could exceed a JS safe integer over a long period is never rounded,
   * and BigInt (which JSON cannot serialise at all) never reaches the encoder.
   */
  private serialize<T extends Record<string, unknown>>(settlement: T): SerializedSettlement<T> {
    const bigintFields = [
      'grossSalesMinor',
      'discountsMinor',
      'refundsMinor',
      'gatewayFeesMinor',
      'expectedNetMinor',
      'actualNetMinor',
      'varianceMinor',
    ];

    const out: Record<string, unknown> = { ...settlement };
    for (const field of bigintFields) {
      if (typeof out[field] === 'bigint') {
        out[field] = out[field].toString();
      }
    }
    return out as SerializedSettlement<T>;
  }
}

type SerializedSettlement<T> = {
  [K in keyof T]: T[K] extends bigint ? string : T[K];
};
