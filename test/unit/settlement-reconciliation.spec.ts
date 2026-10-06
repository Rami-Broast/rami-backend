import { SettlementMatchStatus } from '@prisma/client';

import {
  OwnPayment,
  OwnRefund,
  PayoutLine,
  reconcileSettlement,
} from '../../src/settlements/settlement-reconciliation';

/**
 * The reconciliation core (Phase 18) proven in isolation.
 *
 * Expected net is reconstructed from our own payment/refund/fee records and
 * compared against the payout — never derived from order totals. Every match
 * outcome the settlement flags for review (unmatched, duplicate, missing,
 * unexpected) has a case here.
 */
describe('reconcileSettlement', () => {
  const payment = (over: Partial<OwnPayment> = {}): OwnPayment => ({
    paymentId: 'pay-1',
    gatewayReference: 'gw-pay-1',
    capturedAmountMinor: 11_500,
    feeMinor: 288,
    ...over,
  });

  const refund = (over: Partial<OwnRefund> = {}): OwnRefund => ({
    refundId: 'ref-1',
    gatewayReference: 'gw-ref-1',
    amountMinor: 5000,
    ...over,
  });

  const paymentLine = (over: Partial<PayoutLine> = {}): PayoutLine => ({
    gatewayReference: 'gw-pay-1',
    type: 'PAYMENT',
    amountMinor: 11_500,
    feeMinor: 288,
    ...over,
  });

  it('cleanly matches a payout that agrees with our records', () => {
    const result = reconcileSettlement([paymentLine()], [payment()], []);

    expect(result.hasDiscrepancy).toBe(false);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].matchStatus).toBe(SettlementMatchStatus.MATCHED);
    expect(result.lines[0].paymentId).toBe('pay-1');
    // Net in = amount − fee.
    expect(result.lines[0].netMinor).toBe(11_212);
    expect(result.grossSalesMinor).toBe(11_500);
    expect(result.gatewayFeesMinor).toBe(288);
    expect(result.expectedNetMinor).toBe(11_212);
    expect(result.actualNetMinor).toBe(11_212);
    expect(result.varianceMinor).toBe(0);
  });

  it('reconstructs expected net from payments, refunds and fees — not order totals', () => {
    // Two payments captured, one partial refund. Expected net =
    // (11500 + 8000) − (288 + 200) − 5000 = 14012.
    const payments = [
      payment(),
      payment({
        paymentId: 'pay-2',
        gatewayReference: 'gw-pay-2',
        capturedAmountMinor: 8000,
        feeMinor: 200,
      }),
    ];
    const refunds = [refund()];
    const lines: PayoutLine[] = [
      paymentLine(),
      paymentLine({ gatewayReference: 'gw-pay-2', amountMinor: 8000, feeMinor: 200 }),
      { gatewayReference: 'gw-ref-1', type: 'REFUND', amountMinor: 5000, feeMinor: 0 },
    ];

    const result = reconcileSettlement(lines, payments, refunds);

    expect(result.grossSalesMinor).toBe(19_500);
    expect(result.gatewayFeesMinor).toBe(488);
    expect(result.refundsMinor).toBe(5000);
    expect(result.expectedNetMinor).toBe(14_012);
    expect(result.actualNetMinor).toBe(14_012);
    expect(result.hasDiscrepancy).toBe(false);
    expect(result.lines.every((l) => l.matchStatus === SettlementMatchStatus.MATCHED)).toBe(true);
  });

  it('flags a payout line for a payment we have no record of as UNMATCHED', () => {
    const result = reconcileSettlement([paymentLine({ gatewayReference: 'gw-unknown' })], [], []);

    expect(result.hasDiscrepancy).toBe(true);
    expect(result.lines[0].matchStatus).toBe(SettlementMatchStatus.UNMATCHED);
    expect(result.lines[0].paymentId).toBeUndefined();
  });

  it('flags an amount mismatch as UNEXPECTED', () => {
    const result = reconcileSettlement([paymentLine({ amountMinor: 9999 })], [payment()], []);

    const line = result.lines.find((l) => l.gatewayReference === 'gw-pay-1');
    expect(line?.matchStatus).toBe(SettlementMatchStatus.UNEXPECTED);
    expect(line?.notes).toContain('11500');
    expect(result.hasDiscrepancy).toBe(true);
  });

  it('flags a fee mismatch as UNEXPECTED even when the amount agrees', () => {
    const result = reconcileSettlement([paymentLine({ feeMinor: 999 })], [payment()], []);

    const line = result.lines.find((l) => l.gatewayReference === 'gw-pay-1');
    expect(line?.matchStatus).toBe(SettlementMatchStatus.UNEXPECTED);
    expect(line?.notes).toContain('Fee');
  });

  it('flags a second payout line for the same payment as DUPLICATE', () => {
    const result = reconcileSettlement([paymentLine(), paymentLine()], [payment()], []);

    const statuses = result.lines.map((l) => l.matchStatus);
    expect(statuses).toContain(SettlementMatchStatus.MATCHED);
    expect(statuses).toContain(SettlementMatchStatus.DUPLICATE);
    expect(result.hasDiscrepancy).toBe(true);
  });

  it('flags a captured payment the payout omitted as MISSING', () => {
    const result = reconcileSettlement([], [payment()], []);

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].matchStatus).toBe(SettlementMatchStatus.MISSING);
    expect(result.lines[0].paymentId).toBe('pay-1');
    expect(result.lines[0].amountMinor).toBe(0);
    // We expected 11212 net; the payout brought nothing.
    expect(result.expectedNetMinor).toBe(11_212);
    expect(result.actualNetMinor).toBe(0);
    expect(result.varianceMinor).toBe(-11_212);
    expect(result.hasDiscrepancy).toBe(true);
  });

  it('treats a refund line as money out', () => {
    const result = reconcileSettlement(
      [{ gatewayReference: 'gw-ref-1', type: 'REFUND', amountMinor: 5000, feeMinor: 0 }],
      [],
      [refund()],
    );

    expect(result.lines[0].matchStatus).toBe(SettlementMatchStatus.MATCHED);
    expect(result.lines[0].netMinor).toBe(-5000);
    expect(result.refundsMinor).toBe(5000);
    expect(result.expectedNetMinor).toBe(-5000);
    expect(result.actualNetMinor).toBe(-5000);
    expect(result.hasDiscrepancy).toBe(false);
  });

  it('reports a non-zero variance as a discrepancy even when every line matched', () => {
    // The payout matches our one payment, but also omits a second captured
    // payment (MISSING) — variance and a missing line both signal review.
    const payments = [
      payment(),
      payment({
        paymentId: 'pay-2',
        gatewayReference: 'gw-pay-2',
        capturedAmountMinor: 8000,
        feeMinor: 200,
      }),
    ];

    const result = reconcileSettlement([paymentLine()], payments, []);

    expect(result.varianceMinor).not.toBe(0);
    expect(result.hasDiscrepancy).toBe(true);
    expect(result.lines.some((l) => l.matchStatus === SettlementMatchStatus.MISSING)).toBe(true);
  });

  it('reconciles an empty payout against no records as a clean, zero settlement', () => {
    const result = reconcileSettlement([], [], []);

    expect(result.lines).toHaveLength(0);
    expect(result.expectedNetMinor).toBe(0);
    expect(result.actualNetMinor).toBe(0);
    expect(result.hasDiscrepancy).toBe(false);
  });
});
