import {
  buildZatcaInvoiceLines,
  sourceLinesFromBreakdown,
  taxExclusiveMinor,
} from '../../src/zatca-invoicing/invoice-lines';
import { BreakdownRow } from '../../src/vat/order-breakdown';

describe('buildZatcaInvoiceLines', () => {
  const RATE = 0.15;

  it('reconciles the invoice total to the captured amount, to the halala', () => {
    // A realistic order: two item lines, a delivery fee and a service charge,
    // all VAT-inclusive, summing to 8050 halalas (80.50 SAR).
    const built = buildZatcaInvoiceLines(
      [
        { name: 'Mixed Grill × 2', grossMinor: 5000 },
        { name: 'Fresh Juice × 1', grossMinor: 1500 },
        { name: 'Delivery fee', grossMinor: 1150 },
        { name: 'Service charge', grossMinor: 400 },
      ],
      RATE,
      8050,
    );

    expect(built.totalInclusiveMinor).toBe(8050);
    expect(built.totalExclusiveMinor + built.totalVatMinor).toBe(8050);
    expect(built.lines).toHaveLength(4);
    // Every unit price is exact to two decimals (no third-decimal drift).
    for (const line of built.lines) {
      expect(Number.isInteger(Math.round(line.unitPrice * 100))).toBe(true);
      expect(line.quantity).toBe(1);
      expect(line.vatPercent).toBe(15);
    }
  });

  it('drops zero-amount rows but keeps the total tied', () => {
    const built = buildZatcaInvoiceLines(
      [
        { name: 'Item total', grossMinor: 4000 },
        { name: 'Extra distance', grossMinor: 0 },
      ],
      RATE,
      4000,
    );
    expect(built.lines).toHaveLength(1);
    expect(built.totalInclusiveMinor).toBe(4000);
  });

  it('refuses to issue when the lines disagree with the captured total', () => {
    expect(() =>
      buildZatcaInvoiceLines([{ name: 'Item total', grossMinor: 4000 }], RATE, 4001),
    ).toThrow(/disagrees with the money charged/);
  });

  it('rejects a negative line', () => {
    expect(() => buildZatcaInvoiceLines([{ name: 'Weird', grossMinor: -100 }], RATE, -100)).toThrow(
      /negative/,
    );
  });

  it('rejects a nonsensical VAT rate', () => {
    expect(() => buildZatcaInvoiceLines([{ name: 'Item', grossMinor: 100 }], 1.15, 100)).toThrow(
      /vatRate/,
    );
  });

  it('handles a zero-VAT order (rate 0): exclusive equals inclusive', () => {
    const built = buildZatcaInvoiceLines([{ name: 'Item', grossMinor: 1000 }], 0, 1000);
    expect(built.totalExclusiveMinor).toBe(1000);
    expect(built.totalVatMinor).toBe(0);
    expect(built.lines[0].unitPrice).toBe(10);
  });
});

describe('sourceLinesFromBreakdown', () => {
  const row = (over: Partial<BreakdownRow>): BreakdownRow => ({
    kind: 'ITEMS',
    label: 'Item total',
    detail: null,
    amountMinor: 0,
    included: false,
    negative: false,
    ...over,
  });

  it('keeps the contributing rows and drops VAT and the grand total', () => {
    const rows: BreakdownRow[] = [
      row({ kind: 'ITEMS', label: 'Item total', amountMinor: 6000 }),
      row({ kind: 'DELIVERY_BASE', label: 'Delivery fee', detail: '7 km', amountMinor: 1100 }),
      row({ kind: 'VAT', label: 'VAT', amountMinor: 927, included: true }),
      row({ kind: 'TOTAL', label: 'Total', amountMinor: 7100 }),
    ];
    const lines = sourceLinesFromBreakdown(rows);
    expect(lines).toEqual([
      { name: 'Item total', grossMinor: 6000 },
      { name: 'Delivery fee (7 km)', grossMinor: 1100 },
    ]);
    // And the contributing rows tie to the total, so the invoice will reconcile.
    const built = buildZatcaInvoiceLines(lines, 0.15, 7100);
    expect(built.totalInclusiveMinor).toBe(7100);
  });

  it('refuses a negative contributing row', () => {
    expect(() =>
      sourceLinesFromBreakdown([
        row({ kind: 'DISCOUNT', label: 'Discount', amountMinor: -500, negative: true }),
      ]),
    ).toThrow(/cannot be negative/);
  });
});

describe('taxExclusiveMinor', () => {
  it('splits a VAT-inclusive amount at 15%', () => {
    // 115.00 inclusive at 15% -> 100.00 exclusive.
    expect(taxExclusiveMinor(11500, 0.15)).toBe(10000);
  });

  it('rounds half away from zero, mirroring money.ts', () => {
    // 1000 / 1.15 = 869.565... -> 870
    expect(taxExclusiveMinor(1000, 0.15)).toBe(870);
  });
});
