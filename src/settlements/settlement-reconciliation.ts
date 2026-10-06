import { SettlementMatchStatus } from '@prisma/client';

/**
 * Settlement reconciliation — the pure core (Phase 18).
 *
 * A gateway payout report is matched, line by line, against what our own
 * payment and refund records say should have moved. This module holds that
 * matching as a pure function so it is exhaustively testable in isolation and
 * cannot drift between the places that call it. The service around it feeds it
 * database facts and persists the result; no database, money-fetching or
 * framework lives here.
 *
 * The specification's rule is the whole reason this is arithmetic-heavy rather
 * than a lookup: **settlement is never derived from order totals.** Expected
 * net is reconstructed from captured payments, completed refunds and recorded
 * gateway fees — the actual money records — and compared against what the
 * gateway says it paid out. A non-zero variance, or any line that does not
 * cleanly match, is a discrepancy a human must review before sign-off.
 */

/** Direction of a payout line. Payments bring money in; refunds send it out. */
export type PayoutLineType = 'PAYMENT' | 'REFUND';

/** One line of a gateway payout report, as submitted for reconciliation. */
export interface PayoutLine {
  /** The gateway's own identifier for the underlying charge or refund. */
  gatewayReference: string;
  type: PayoutLineType;
  /** Gross amount moved on this line, in minor units. Always positive. */
  amountMinor: number;
  /** Gateway fee charged on this line, in minor units. */
  feeMinor: number;
}

/** One of our captured gateway payments, as a reconciliation fact. */
export interface OwnPayment {
  paymentId: string;
  gatewayReference: string;
  capturedAmountMinor: number;
  feeMinor: number;
}

/** One of our completed gateway refunds, as a reconciliation fact. */
export interface OwnRefund {
  refundId: string;
  gatewayReference: string;
  amountMinor: number;
}

/** A single payout line after matching, ready to persist as a SettlementTransaction. */
export interface ReconciledLine {
  matchStatus: SettlementMatchStatus;
  type: PayoutLineType;
  paymentId?: string;
  refundId?: string;
  gatewayReference?: string;
  /** The payout amount for this line (0 for a MISSING record the payout omitted). */
  amountMinor: number;
  feeMinor: number;
  /** Signed cash effect of this line: positive in, negative out. */
  netMinor: number;
  /** A human-readable explanation for anything that is not a clean match. */
  notes?: string;
}

export interface ReconciliationResult {
  lines: ReconciledLine[];
  /** From the payout: the net the gateway claims it moved. */
  actualNetMinor: number;
  /** From our records: the net that should have moved. */
  expectedNetMinor: number;
  /** actual − expected. Non-zero requires investigation. */
  varianceMinor: number;
  grossSalesMinor: number;
  refundsMinor: number;
  gatewayFeesMinor: number;
  /** True when any line did not cleanly match, or the variance is non-zero. */
  hasDiscrepancy: boolean;
}

/** The signed cash effect of one payout line. */
function netOf(line: PayoutLine): number {
  return line.type === 'PAYMENT'
    ? line.amountMinor - line.feeMinor
    : -(line.amountMinor + line.feeMinor);
}

/**
 * Matches a gateway payout against our own records.
 *
 * Every payout line is classified against what we hold:
 *
 *   - **MATCHED** — a record with that reference exists and its amount (and
 *     fee) agree.
 *   - **UNEXPECTED** — a record exists but the amount or fee disagrees. The
 *     gateway moved a different sum than we recorded; the note says which.
 *   - **DUPLICATE** — a second payout line for a record an earlier line
 *     already accounted for.
 *   - **UNMATCHED** — the payout references something we have no record of.
 *
 * After the lines are walked, any of our own captured payments or completed
 * refunds that no line referenced is emitted as a **MISSING** line: we expected
 * it in the payout and it was not there.
 *
 * Expected net comes only from our payment/refund/fee records; actual net comes
 * only from the payout. They are compared, never conflated.
 */
export function reconcileSettlement(
  payoutLines: readonly PayoutLine[],
  ownPayments: readonly OwnPayment[],
  ownRefunds: readonly OwnRefund[],
): ReconciliationResult {
  const paymentsByRef = new Map(ownPayments.map((p) => [p.gatewayReference, p]));
  const refundsByRef = new Map(ownRefunds.map((r) => [r.gatewayReference, r]));
  const consumedPayments = new Set<string>();
  const consumedRefunds = new Set<string>();

  const lines: ReconciledLine[] = [];
  let actualNetMinor = 0;

  for (const line of payoutLines) {
    const net = netOf(line);
    actualNetMinor += net;

    if (line.type === 'PAYMENT') {
      lines.push(
        matchAgainst(line, net, paymentsByRef, consumedPayments, {
          idKey: 'paymentId',
          record: paymentsByRef.get(line.gatewayReference),
          ourAmount: (p: OwnPayment) => p.capturedAmountMinor,
          ourFee: (p: OwnPayment) => p.feeMinor,
          id: (p: OwnPayment) => p.paymentId,
        }),
      );
    } else {
      lines.push(
        matchAgainst(line, net, refundsByRef, consumedRefunds, {
          idKey: 'refundId',
          record: refundsByRef.get(line.gatewayReference),
          ourAmount: (r: OwnRefund) => r.amountMinor,
          ourFee: () => 0,
          id: (r: OwnRefund) => r.refundId,
        }),
      );
    }
  }

  // Anything of ours the payout never mentioned is MISSING.
  for (const payment of ownPayments) {
    if (!consumedPayments.has(payment.paymentId)) {
      lines.push({
        matchStatus: SettlementMatchStatus.MISSING,
        type: 'PAYMENT',
        paymentId: payment.paymentId,
        gatewayReference: payment.gatewayReference,
        amountMinor: 0,
        feeMinor: 0,
        netMinor: 0,
        notes: `Captured payment of ${payment.capturedAmountMinor} not present in the payout.`,
      });
    }
  }
  for (const refund of ownRefunds) {
    if (!consumedRefunds.has(refund.refundId)) {
      lines.push({
        matchStatus: SettlementMatchStatus.MISSING,
        type: 'REFUND',
        refundId: refund.refundId,
        gatewayReference: refund.gatewayReference,
        amountMinor: 0,
        feeMinor: 0,
        netMinor: 0,
        notes: `Completed refund of ${refund.amountMinor} not present in the payout.`,
      });
    }
  }

  const grossSalesMinor = ownPayments.reduce((sum, p) => sum + p.capturedAmountMinor, 0);
  const gatewayFeesMinor = ownPayments.reduce((sum, p) => sum + p.feeMinor, 0);
  const refundsMinor = ownRefunds.reduce((sum, r) => sum + r.amountMinor, 0);
  const expectedNetMinor = grossSalesMinor - gatewayFeesMinor - refundsMinor;
  const varianceMinor = actualNetMinor - expectedNetMinor;

  const hasDiscrepancy =
    varianceMinor !== 0 || lines.some((l) => l.matchStatus !== SettlementMatchStatus.MATCHED);

  return {
    lines,
    actualNetMinor,
    expectedNetMinor,
    varianceMinor,
    grossSalesMinor,
    refundsMinor,
    gatewayFeesMinor,
    hasDiscrepancy,
  };
}

/** Shared matcher for a payment or refund line against its record map. */
function matchAgainst<T>(
  line: PayoutLine,
  net: number,
  _byRef: Map<string, T>,
  consumed: Set<string>,
  ctx: {
    idKey: 'paymentId' | 'refundId';
    record: T | undefined;
    ourAmount: (record: T) => number;
    ourFee: (record: T) => number;
    id: (record: T) => string;
  },
): ReconciledLine {
  const base: ReconciledLine = {
    matchStatus: SettlementMatchStatus.UNMATCHED,
    type: line.type,
    gatewayReference: line.gatewayReference,
    amountMinor: line.amountMinor,
    feeMinor: line.feeMinor,
    netMinor: net,
  };

  if (!ctx.record) {
    return { ...base, notes: 'No matching record for this gateway reference.' };
  }

  const id = ctx.id(ctx.record);
  const linkage = { [ctx.idKey]: id };

  if (consumed.has(id)) {
    return {
      ...base,
      ...linkage,
      matchStatus: SettlementMatchStatus.DUPLICATE,
      notes: 'A payout line already accounted for this record.',
    };
  }

  consumed.add(id);

  const expectedAmount = ctx.ourAmount(ctx.record);
  const expectedFee = ctx.ourFee(ctx.record);

  if (expectedAmount !== line.amountMinor) {
    return {
      ...base,
      ...linkage,
      matchStatus: SettlementMatchStatus.UNEXPECTED,
      notes: `Amount ${line.amountMinor} does not match our recorded ${expectedAmount}.`,
    };
  }

  if (expectedFee !== line.feeMinor) {
    return {
      ...base,
      ...linkage,
      matchStatus: SettlementMatchStatus.UNEXPECTED,
      notes: `Fee ${line.feeMinor} does not match our recorded ${expectedFee}.`,
    };
  }

  return { ...base, ...linkage, matchStatus: SettlementMatchStatus.MATCHED };
}
