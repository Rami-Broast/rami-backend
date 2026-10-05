import { BadRequestException, Injectable } from '@nestjs/common';
import { DeliveryStatus, OrderStatus, Prisma, RefundRequestType } from '@prisma/client';

import { Actor } from '../auth/types/actor';
import { resolveRequestedBranches } from '../branches/branch-scope';
import { PrismaService } from '../prisma/prisma.service';
import { ReportQueryDto } from './dto/report.dto';

/**
 * Order statuses that count as a realised sale.
 *
 * A sale is realised once payment is taken or a cash-on-delivery order is
 * confirmed for the kitchen — i.e. everything from CONFIRMED onward, including
 * the refund states (the sale happened; a refund is a separate money movement,
 * reconciled in settlements, not a cancellation of the sale). Deliberately
 * excluded: PENDING_PAYMENT (never paid), PAYMENT_FAILED and CANCELLED.
 */
const REALISED_STATUSES: OrderStatus[] = [
  OrderStatus.CONFIRMED,
  OrderStatus.PREPARING,
  OrderStatus.READY,
  OrderStatus.DRIVER_ASSIGNED,
  OrderStatus.PICKED_UP,
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.DELIVERED,
  OrderStatus.REFUND_PENDING,
  OrderStatus.REFUNDED,
  OrderStatus.PARTIALLY_REFUNDED,
];

/**
 * Reports (Phase 18).
 *
 * Sales, VAT and payment reporting. Two rules from the specification shape every
 * query here:
 *
 *   1. **Reports read snapshotted data.** Order figures come from the price
 *      breakdown snapshotted onto the order at purchase (Phase 8), never from
 *      the live catalog, so a menu-price change can never move a historical
 *      report. The VAT rate is likewise the rate snapshotted per order, which
 *      is why the VAT report groups by rate rather than assuming one.
 *   2. **Branch isolation is the same as everywhere else.** An owner spans every
 *      branch; branch staff see only their assignments. The window and any
 *      branch filter are applied through `resolveRequestedBranches`.
 *
 * Money is returned as integer minor units. Sums are bounded to a single
 * reporting window and stay well within a safe integer.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Sales summary for a window: how many orders, broken down by status, and the
   * snapshotted revenue figures over the realised set.
   */
  async salesReport(actor: Actor, query: ReportQueryDto) {
    const { where, from, to } = this.orderScope(actor, query);

    const byStatus = await this.prisma.order.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
      _sum: { totalMinor: true },
    });

    const realisedWhere: Prisma.OrderWhereInput = {
      ...where,
      status: { in: REALISED_STATUSES },
    };

    const totals = await this.prisma.order.aggregate({
      where: realisedWhere,
      _count: { _all: true },
      _sum: {
        subtotalMinor: true,
        discountMinor: true,
        deliveryFeeMinor: true,
        chargesMinor: true,
        taxableBaseMinor: true,
        vatMinor: true,
        totalMinor: true,
      },
    });

    const chargeLines = await this.prisma.orderCharge.groupBy({
      by: ['name'],
      where: { order: realisedWhere },
      _count: { _all: true },
      _sum: { grossMinor: true, vatMinor: true, totalMinor: true },
    });

    const charges = chargeLines
      .map((row) => ({
        name: row.name,
        count: row._count._all,
        grossMinor: row._sum.grossMinor ?? 0,
        vatMinor: row._sum.vatMinor ?? 0,
        totalMinor: row._sum.totalMinor ?? 0,
      }))
      .sort((a, b) => b.totalMinor - a.totalMinor);

    return {
      period: { from, to },
      currency: 'SAR',
      statusBreakdown: byStatus
        .map((row) => ({
          status: row.status,
          orders: row._count._all,
          totalMinor: row._sum.totalMinor ?? 0,
        }))
        .sort((a, b) => a.status.localeCompare(b.status)),
      realised: {
        // The revenue figures below cover only realised sales — see
        // REALISED_STATUSES. Cancelled and payment-failed orders are excluded.
        orders: totals._count._all,
        subtotalMinor: totals._sum.subtotalMinor ?? 0,
        discountMinor: totals._sum.discountMinor ?? 0,
        deliveryFeeMinor: totals._sum.deliveryFeeMinor ?? 0,
        chargesMinor: totals._sum.chargesMinor ?? 0,
        taxableBaseMinor: totals._sum.taxableBaseMinor ?? 0,
        vatMinor: totals._sum.vatMinor ?? 0,
        totalMinor: totals._sum.totalMinor ?? 0,
      },
      charges,
    };
  }

  /**
   * Charges breakdown over the reporting window.
   *
   * Groups `OrderCharge` rows by name (and optionally by chargeId for rows that
   * still reference an active Charge definition) over realised-sales orders.
   * Each row shows gross, VAT and total, so the owner can see how much revenue
   * each charge type contributed.
   */
  async chargesReport(actor: Actor, query: ReportQueryDto) {
    const { where, from, to } = this.orderScope(actor, query);

    const realisedWhere: Prisma.OrderWhereInput = {
      ...where,
      status: { in: REALISED_STATUSES },
    };

    const chargeLines = await this.prisma.orderCharge.findMany({
      where: { order: realisedWhere },
      select: {
        chargeId: true,
        name: true,
        grossMinor: true,
        vatMinor: true,
        totalMinor: true,
        taxable: true,
      },
    });

    type ChargeAgg = {
      chargeId: string | null;
      name: string;
      count: number;
      grossMinor: number;
      vatMinor: number;
      totalMinor: number;
      taxable: boolean;
    };

    const byKey = new Map<string, ChargeAgg>();
    for (const line of chargeLines) {
      const key = `${line.chargeId ?? ''}|${line.name}`;
      let agg = byKey.get(key);
      if (!agg) {
        agg = {
          chargeId: line.chargeId,
          name: line.name,
          count: 0,
          grossMinor: 0,
          vatMinor: 0,
          totalMinor: 0,
          taxable: line.taxable,
        };
        byKey.set(key, agg);
      }
      agg.count += 1;
      agg.grossMinor += line.grossMinor;
      agg.vatMinor += line.vatMinor;
      agg.totalMinor += line.totalMinor;
    }

    const rows = Array.from(byKey.values()).sort((a, b) => b.totalMinor - a.totalMinor);

    const totals = rows.reduce(
      (acc, r) => {
        acc.count += r.count;
        acc.grossMinor += r.grossMinor;
        acc.vatMinor += r.vatMinor;
        acc.totalMinor += r.totalMinor;
        return acc;
      },
      { count: 0, grossMinor: 0, vatMinor: 0, totalMinor: 0 },
    );

    return {
      period: { from, to },
      currency: 'SAR',
      charges: rows,
      totals,
    };
  }

  /**
   * VAT summary for a window, grouped by the VAT rate snapshotted on each order.
   *
   * Grouping by rate rather than assuming one is deliberate: the rate is
   * snapshotted per order, so a statutory rate change shows as two groups here
   * with no historical figure disturbed.
   *
   * **Gross output VAT only, permanently.** This does not net VAT returned by
   * refunds or credit notes — that would need per-line refund VAT and a
   * credit-note model, and invoicing is **out of scope for this platform**: the
   * restaurant issues its own tax invoices and credit notes through its own
   * systems (`DEMO_DECISIONS.md`, `src/invoices/README.md`). So this is a
   * standing property, not a gap waiting on a later phase. Flagged in the
   * response so a reader never mistakes gross for net, and whoever prepares the
   * VAT return nets refunds from the restaurant's own invoicing records.
   */
  async vatReport(actor: Actor, query: ReportQueryDto) {
    const { where, from, to } = this.orderScope(actor, query);

    const realisedWhere: Prisma.OrderWhereInput = {
      ...where,
      status: { in: REALISED_STATUSES },
    };

    const byRate = await this.prisma.order.groupBy({
      by: ['vatRate'],
      where: realisedWhere,
      _count: { _all: true },
      _sum: { taxableBaseMinor: true, vatMinor: true, totalMinor: true },
    });

    const rows = byRate
      .map((row) => ({
        vatRate: row.vatRate.toString(),
        orders: row._count._all,
        taxableBaseMinor: row._sum.taxableBaseMinor ?? 0,
        vatMinor: row._sum.vatMinor ?? 0,
        totalMinor: row._sum.totalMinor ?? 0,
      }))
      .sort((a, b) => a.vatRate.localeCompare(b.vatRate));

    return {
      period: { from, to },
      currency: 'SAR',
      basis: 'gross' as const,
      note: "Gross output VAT on realised sales. Refund/credit-note VAT is never netted here — invoicing is out of scope; net it from the restaurant's own invoicing records.",
      byRate: rows,
      totalVatMinor: rows.reduce((sum, r) => sum + r.vatMinor, 0),
      totalTaxableBaseMinor: rows.reduce((sum, r) => sum + r.taxableBaseMinor, 0),
    };
  }

  /**
   * Payment summary for a window: captured and refunded money by payment status
   * and by method. Read from Payment records — the money movements — not orders.
   */
  async paymentsReport(actor: Actor, query: ReportQueryDto) {
    const { from, to } = this.window(query);
    const orderFilter = resolveRequestedBranches(actor, query.branchId);

    const where: Prisma.PaymentWhereInput = {
      createdAt: { gte: from, lte: to },
      order: { deletedAt: null, ...orderFilter },
    };

    const [byStatus, byMethod, totals] = await Promise.all([
      this.prisma.payment.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
        _sum: { capturedAmountMinor: true, refundedAmountMinor: true },
      }),
      this.prisma.payment.groupBy({
        by: ['method'],
        where,
        _count: { _all: true },
        _sum: { capturedAmountMinor: true, refundedAmountMinor: true },
      }),
      this.prisma.payment.aggregate({
        where,
        _count: { _all: true },
        _sum: { capturedAmountMinor: true, refundedAmountMinor: true, gatewayFeeMinor: true },
      }),
    ]);

    return {
      period: { from, to },
      currency: 'SAR',
      byStatus: byStatus
        .map((row) => ({
          status: row.status,
          payments: row._count._all,
          capturedMinor: row._sum.capturedAmountMinor ?? 0,
          refundedMinor: row._sum.refundedAmountMinor ?? 0,
        }))
        .sort((a, b) => a.status.localeCompare(b.status)),
      byMethod: byMethod
        .map((row) => ({
          method: row.method,
          payments: row._count._all,
          capturedMinor: row._sum.capturedAmountMinor ?? 0,
          refundedMinor: row._sum.refundedAmountMinor ?? 0,
        }))
        .sort((a, b) => (a.method ?? '').localeCompare(b.method ?? '')),
      totals: {
        payments: totals._count._all,
        capturedMinor: totals._sum.capturedAmountMinor ?? 0,
        refundedMinor: totals._sum.refundedAmountMinor ?? 0,
        gatewayFeesMinor: totals._sum.gatewayFeeMinor ?? 0,
        netCapturedMinor:
          (totals._sum.capturedAmountMinor ?? 0) - (totals._sum.refundedAmountMinor ?? 0),
      },
    };
  }

  /**
   * Per-driver delivery performance over the window.
   *
   * Read from Delivery timestamps (assigned/pickedUp/delivered) — the same
   * choke-point-stamped values the delivery state machine already writes, so
   * a driver metric here can never disagree with the underlying job history.
   *
   * Reports **completed** deliveries only (`DeliveryStatus.DELIVERED`), so a
   * cancelled or failed job never drags an average up or down. A delivery
   * missing `assignedAt` or `pickedUpAt` (which shouldn't happen for a
   * DELIVERED row — the state machine populates them on the transitions that
   * lead there) is skipped defensively.
   *
   * Branch scope: OWNER sees every branch; branch staff see only their own.
   * The filter matches Delivery.branchId, snapshotted at creation, so a
   * later branch reassignment (not currently a legal move) could not
   * silently leak history.
   */
  async driverPerformanceReport(actor: Actor, query: ReportQueryDto) {
    const { from, to } = this.window(query);
    const orderScope = resolveRequestedBranches(actor, query.branchId);

    const deliveries = await this.prisma.delivery.findMany({
      where: {
        status: DeliveryStatus.DELIVERED,
        deliveredAt: { gte: from, lte: to },
        assignedAt: { not: null },
        pickedUpAt: { not: null },
        driverId: { not: null },
        // Delivery.branchId is snapshotted so this filter is safe to apply
        // directly (rather than via the parent Order).
        ...(orderScope.branchId ? { branchId: orderScope.branchId } : {}),
      },
      select: {
        id: true,
        driverId: true,
        branchId: true,
        assignedAt: true,
        pickedUpAt: true,
        deliveredAt: true,
        driver: {
          select: {
            id: true,
            user: { select: { fullName: true, email: true } },
          },
        },
        branch: { select: { id: true, code: true, name: true } },
      },
    });

    type Agg = {
      driverId: string;
      driverName: string | null;
      driverEmail: string;
      branch: { id: string; code: string; name: string } | null;
      deliveries: number;
      pickupSecondsTotal: number;
      deliverySecondsTotal: number;
      dayKeys: Set<string>;
    };

    const byDriver = new Map<string, Agg>();

    for (const d of deliveries) {
      if (
        d.driverId === null ||
        d.assignedAt === null ||
        d.pickedUpAt === null ||
        d.deliveredAt === null
      ) {
        continue;
      }

      const assigned = d.assignedAt.getTime();
      const pickedUp = d.pickedUpAt.getTime();
      const delivered = d.deliveredAt.getTime();
      // Defensive: a negative interval means the timestamps disagree, which
      // shouldn't happen; skipping is safer than pulling the average down.
      const pickupSec = Math.max(0, Math.round((pickedUp - assigned) / 1000));
      const deliverySec = Math.max(0, Math.round((delivered - pickedUp) / 1000));

      let agg = byDriver.get(d.driverId);
      if (!agg) {
        agg = {
          driverId: d.driverId,
          driverName: d.driver?.user.fullName ?? null,
          driverEmail: d.driver?.user.email ?? '',
          branch: d.branch,
          deliveries: 0,
          pickupSecondsTotal: 0,
          deliverySecondsTotal: 0,
          dayKeys: new Set(),
        };
        byDriver.set(d.driverId, agg);
      }
      agg.deliveries += 1;
      agg.pickupSecondsTotal += pickupSec;
      agg.deliverySecondsTotal += deliverySec;
      agg.dayKeys.add(d.deliveredAt.toISOString().slice(0, 10));
    }

    const rows = Array.from(byDriver.values())
      .map((row) => ({
        driverId: row.driverId,
        driverName: row.driverName,
        driverEmail: row.driverEmail,
        branch: row.branch,
        deliveries: row.deliveries,
        avgTimeToPickupSeconds: Math.round(row.pickupSecondsTotal / row.deliveries),
        avgDeliveryTimeSeconds: Math.round(row.deliverySecondsTotal / row.deliveries),
        activeDays: row.dayKeys.size,
        deliveriesPerActiveDay:
          row.dayKeys.size > 0
            ? Number((row.deliveries / row.dayKeys.size).toFixed(2))
            : row.deliveries,
      }))
      .sort((a, b) => b.deliveries - a.deliveries);

    const totals = rows.reduce(
      (acc, r) => {
        acc.deliveries += r.deliveries;
        acc.pickupSeconds += r.avgTimeToPickupSeconds * r.deliveries;
        acc.deliverySeconds += r.avgDeliveryTimeSeconds * r.deliveries;
        return acc;
      },
      { deliveries: 0, pickupSeconds: 0, deliverySeconds: 0 },
    );

    return {
      period: { from, to },
      drivers: rows,
      totals: {
        deliveries: totals.deliveries,
        avgTimeToPickupSeconds:
          totals.deliveries > 0 ? Math.round(totals.pickupSeconds / totals.deliveries) : 0,
        avgDeliveryTimeSeconds:
          totals.deliveries > 0 ? Math.round(totals.deliverySeconds / totals.deliveries) : 0,
      },
    };
  }

  /**
   * Dashboard KPI tiles — a compact rollup for the admin home page.
   *
   * Prep time is measured across the CONFIRMED → READY transitions on
   * `OrderStatusHistory` (same choke point as the order state machine).
   * Delivery time is measured across the Delivery timestamps, same as the
   * driver report — so the two dashboard tiles cannot disagree with their
   * source-of-truth reports.
   */
  /**
   * Customers the refund and cancellation windows turned away, and by how much
   * they missed.
   *
   * This is the report that tells an owner whether their own policy is the
   * right length. Every other refund figure counts what happened; this one
   * counts what was **prevented**, which is the half no other report can see —
   * a refused customer leaves no request, no refund and no order change, so
   * without this a window that is too short looks exactly like a window nobody
   * needed.
   *
   * The buckets are the actionable part. "Forty people missed it" invites an
   * argument; "and thirty of them by under five minutes" answers what the
   * window should be.
   */
  async refundWindowMissesReport(actor: Actor, query: ReportQueryDto) {
    const from = new Date(query.from);
    const to = new Date(query.to);

    const where: Prisma.RefundWindowMissWhereInput = {
      createdAt: { gte: from, lt: to },
      ...resolveRequestedBranches(actor, query.branchId),
    };

    // Two plain counts rather than a groupBy: there are exactly two types, and
    // the counts read the same in the response either way.
    const [total, cancellations, refunds, misses] = await this.prisma.$transaction([
      this.prisma.refundWindowMiss.count({ where }),
      this.prisma.refundWindowMiss.count({
        where: { ...where, type: RefundRequestType.CANCELLATION },
      }),
      this.prisma.refundWindowMiss.count({ where: { ...where, type: RefundRequestType.REFUND } }),
      this.prisma.refundWindowMiss.findMany({
        where,
        select: { minutesLate: true, windowMinutes: true },
        // Bounded: this is a diagnostic read, not a ledger, and a window that is
        // badly wrong could otherwise return a very large list.
        take: 5_000,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const late = misses.map((m) => m.minutesLate).sort((a, b) => a - b);
    const within = (minutes: number): number => late.filter((m) => m <= minutes).length;

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      /** How many customers were refused because their window had shut. */
      total,
      byType: { cancellation: cancellations, refund: refunds },
      /**
       * How many of them would have been inside a longer window. Read this as
       * "extending the window by N minutes would have admitted this many".
       */
      wouldHaveBeenCaughtBy: {
        plus5Minutes: within(5),
        plus15Minutes: within(15),
        plus30Minutes: within(30),
        plus60Minutes: within(60),
      },
      medianMinutesLate: late.length ? late[Math.floor(late.length / 2)] : null,
      maxMinutesLate: late.length ? late[late.length - 1] : null,
      /** The window in force for the rows counted, where they all agree. */
      windowMinutes: (() => {
        const windows = new Set(misses.map((m) => m.windowMinutes));
        return windows.size === 1 ? [...windows][0] : null;
      })(),
      sampled: misses.length < total,
    };
  }

  async dashboardKpis(actor: Actor, query: ReportQueryDto) {
    const { from, to } = this.window(query);
    const orderScope = resolveRequestedBranches(actor, query.branchId);

    // Prep-time: pair CONFIRMED with the next READY on the same order, within
    // the window. Grouped by orderId so paired rows survive concurrent orders.
    const confirmed = await this.prisma.orderStatusHistory.findMany({
      where: {
        toStatus: OrderStatus.CONFIRMED,
        createdAt: { gte: from, lte: to },
        order: { deletedAt: null, ...orderScope },
      },
      select: { orderId: true, createdAt: true },
    });
    const ready = await this.prisma.orderStatusHistory.findMany({
      where: {
        toStatus: OrderStatus.READY,
        createdAt: { gte: from, lte: to },
        order: { deletedAt: null, ...orderScope },
      },
      select: { orderId: true, createdAt: true },
    });

    const readyByOrder = new Map<string, number>();
    for (const r of ready) {
      // If READY appears more than once on the same order (shouldn't in
      // practice), take the earliest — that's when the kitchen finished.
      const existing = readyByOrder.get(r.orderId);
      const t = r.createdAt.getTime();
      if (existing === undefined || t < existing) {
        readyByOrder.set(r.orderId, t);
      }
    }

    let prepSum = 0;
    let prepCount = 0;
    for (const c of confirmed) {
      const rTime = readyByOrder.get(c.orderId);
      if (rTime === undefined) continue;
      const diff = rTime - c.createdAt.getTime();
      if (diff < 0) continue; // defensive; skip disordered pair
      prepSum += diff;
      prepCount += 1;
    }

    // Delivery time: same source as the driver report — one source of truth.
    const deliveries = await this.prisma.delivery.findMany({
      where: {
        status: DeliveryStatus.DELIVERED,
        deliveredAt: { gte: from, lte: to },
        pickedUpAt: { not: null },
        ...(orderScope.branchId ? { branchId: orderScope.branchId } : {}),
      },
      select: { pickedUpAt: true, deliveredAt: true },
    });

    let deliverySum = 0;
    let deliveryCount = 0;
    for (const d of deliveries) {
      if (d.pickedUpAt === null || d.deliveredAt === null) continue;
      const diff = d.deliveredAt.getTime() - d.pickedUpAt.getTime();
      if (diff < 0) continue;
      deliverySum += diff;
      deliveryCount += 1;
    }

    return {
      period: { from, to },
      avgPrepTimeSeconds: prepCount > 0 ? Math.round(prepSum / prepCount / 1000) : null,
      prepTimeSamples: prepCount,
      avgDeliveryTimeSeconds:
        deliveryCount > 0 ? Math.round(deliverySum / deliveryCount / 1000) : null,
      deliveryTimeSamples: deliveryCount,
    };
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  /** Parses and validates the reporting window. */
  private window(query: ReportQueryDto): { from: Date; to: Date } {
    const from = new Date(query.from);
    const to = new Date(query.to);
    if (to <= from) {
      throw new BadRequestException('`to` must be after `from`.');
    }
    return { from, to };
  }

  /** The order `where` fragment for a report: window, branch scope, not deleted. */
  private orderScope(actor: Actor, query: ReportQueryDto) {
    const { from, to } = this.window(query);
    const where: Prisma.OrderWhereInput = {
      deletedAt: null,
      placedAt: { gte: from, lte: to },
      ...resolveRequestedBranches(actor, query.branchId),
    };
    return { where, from, to };
  }
}
