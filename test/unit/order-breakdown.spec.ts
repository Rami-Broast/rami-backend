import { Prisma } from '@prisma/client';

import { DeliveryQuote } from '../../src/delivery-pricing/delivery-pricing';
import {
  assertBreakdownAddsUp,
  BreakdownRow,
  buildOrderBreakdown,
} from '../../src/vat/order-breakdown';
import { PriceQuote } from '../../src/vat/pricing.types';

function quote(overrides: Record<string, unknown> = {}): PriceQuote {
  return {
    currency: 'SAR',
    vatRate: new Prisma.Decimal('0.15'),
    pricesIncludeVat: true,
    lines: [],
    fees: [],
    subtotalMinor: 6000,
    discountMinor: 0,
    deliveryFeeMinor: 0,
    chargesMinor: 0,
    taxableBaseMinor: 5217,
    vatMinor: 783,
    totalMinor: 6000,
    appliedDiscounts: [],
    ...overrides,
  } as unknown as PriceQuote;
}

function delivery(overrides: Partial<DeliveryQuote> = {}): DeliveryQuote {
  return {
    distanceKm: 7,
    straightLineKm: 5.38,
    baseFeeMinor: 500,
    baseFeeCoversKm: 5,
    chargeableKm: 2,
    perKmFeeMinor: 300,
    distanceFeeMinor: 600,
    deliveryFeeMinor: 1100,
    minOrderMinor: 4000,
    shortfallMinor: 0,
    maxRadiusKm: null,
    blockers: [],
    ...overrides,
  };
}

const kinds = (rows: BreakdownRow[]): string[] => rows.map((row) => row.kind);
const find = (rows: BreakdownRow[], kind: string): BreakdownRow | undefined =>
  rows.find((row) => row.kind === kind);

describe('buildOrderBreakdown', () => {
  it('lists items, VAT and what to pay on the simplest pickup order', () => {
    expect(kinds(buildOrderBreakdown(quote(), null))).toEqual(['ITEMS', 'VAT', 'TOTAL']);
    expect(find(buildOrderBreakdown(quote(), null), 'TOTAL')?.label).toBe('To pay');
  });

  it('marks VAT as already inside the total, so nobody adds it twice', () => {
    // Prices are VAT-inclusive. A client that summed every row would overstate
    // every order in the system by 15%.
    const vat = find(buildOrderBreakdown(quote(), null), 'VAT');

    expect(vat?.included).toBe(true);
    expect(vat?.detail).toBe('15%, included');
  });

  it('splits the delivery fee into the flat part and the distance part', () => {
    const rows = buildOrderBreakdown(
      quote({ deliveryFeeMinor: 1100, totalMinor: 7100, vatMinor: 926, taxableBaseMinor: 6174 }),
      delivery(),
    );

    expect(kinds(rows)).toEqual(['ITEMS', 'DELIVERY_BASE', 'DELIVERY_DISTANCE', 'VAT', 'TOTAL']);
    expect(find(rows, 'DELIVERY_BASE')?.amountMinor).toBe(500);
    expect(find(rows, 'DELIVERY_DISTANCE')?.amountMinor).toBe(600);
    expect(find(rows, 'DELIVERY_DISTANCE')?.detail).toBe('2 km beyond 5 km × 3.00');
  });

  it('omits the distance row when the drop-off was inside the covered distance', () => {
    const rows = buildOrderBreakdown(
      quote({ deliveryFeeMinor: 500, totalMinor: 6500, vatMinor: 848, taxableBaseMinor: 5652 }),
      delivery({ chargeableKm: 0, distanceFeeMinor: 0, deliveryFeeMinor: 500, distanceKm: 3 }),
    );

    expect(kinds(rows)).not.toContain('DELIVERY_DISTANCE');
    expect(find(rows, 'DELIVERY_BASE')?.detail).toBe('3 km · first 5 km included');
  });

  it('says nothing about distance when the distance is unknown', () => {
    const rows = buildOrderBreakdown(
      quote({ deliveryFeeMinor: 500, totalMinor: 6500, vatMinor: 848, taxableBaseMinor: 5652 }),
      delivery({ distanceKm: null, chargeableKm: 0, distanceFeeMinor: 0, deliveryFeeMinor: 500 }),
    );

    // Better a bare "Delivery 5.00" than an invented number.
    expect(find(rows, 'DELIVERY_BASE')?.detail).toBeNull();
  });

  it('strikes the item total through rather than adding a discount row', () => {
    // "60.00 struck through, 50.00" reads as a saving immediately. "Items
    // 60.00 / Discount −10.00" is arithmetic the customer has to do first.
    const rows = buildOrderBreakdown(
      quote({
        discountMinor: 1000,
        totalMinor: 5000,
        vatMinor: 652,
        taxableBaseMinor: 4348,
        lines: [{ lineDiscountMinor: 1000 }],
      }),
      null,
    );

    expect(kinds(rows)).toEqual(['ITEMS', 'VAT', 'TOTAL']);
    expect(find(rows, 'ITEMS')?.amountMinor).toBe(5000);
    expect(find(rows, 'ITEMS')?.strikethroughMinor).toBe(6000);
  });

  it('carries no strikethrough when nothing was discounted', () => {
    expect(find(buildOrderBreakdown(quote(), null), 'ITEMS')?.strikethroughMinor).toBeUndefined();
  });

  /**
   * The case that broke placement outright.
   *
   * A free-delivery coupon on an address beyond the base-fee radius discounts
   * the *whole* delivery leg — base plus distance. The rows only ever spent the
   * discount on the base fee and silently dropped the rest, so they summed
   * higher than the total, `assertBreakdownAddsUp` threw, and the order failed
   * with a 500 on the Pay button. For the customer holding the best coupon we
   * issue, and only when they live far enough away.
   */
  it('spends a free-delivery discount on the distance fee too, so the rows still add up', () => {
    const rows = buildOrderBreakdown(
      quote({
        // 60.00 of food, an 11.00 delivery leg entirely discounted.
        discountMinor: 1100,
        deliveryFeeMinor: 1100,
        totalMinor: 6000,
        vatMinor: 783,
        taxableBaseMinor: 5217,
        fees: [
          {
            kind: 'DELIVERY',
            label: 'Delivery fee',
            grossMinor: 1100,
            discountMinor: 1100,
            taxableBaseMinor: 0,
            vatMinor: 0,
            totalMinor: 0,
            taxable: true,
          },
        ],
      }),
      delivery(),
    );

    expect(find(rows, 'DELIVERY_BASE')?.amountMinor).toBe(0);
    expect(find(rows, 'DELIVERY_BASE')?.strikethroughMinor).toBe(500);
    expect(find(rows, 'DELIVERY_DISTANCE')?.amountMinor).toBe(0);
    expect(find(rows, 'DELIVERY_DISTANCE')?.strikethroughMinor).toBe(600);
    expect(() => assertBreakdownAddsUp(rows)).not.toThrow();
  });

  it('spends a partial delivery discount on the base fee first', () => {
    // 3.00 off an 11.00 leg: the base fee absorbs it and the distance row is
    // untouched, so no strikethrough appears on a row nothing came off.
    const rows = buildOrderBreakdown(
      quote({
        discountMinor: 300,
        deliveryFeeMinor: 1100,
        totalMinor: 6800,
        vatMinor: 887,
        taxableBaseMinor: 5913,
        fees: [
          {
            kind: 'DELIVERY',
            label: 'Delivery fee',
            grossMinor: 1100,
            discountMinor: 300,
            taxableBaseMinor: 696,
            vatMinor: 104,
            totalMinor: 800,
            taxable: true,
          },
        ],
      }),
      delivery(),
    );

    expect(find(rows, 'DELIVERY_BASE')?.amountMinor).toBe(200);
    expect(find(rows, 'DELIVERY_DISTANCE')?.amountMinor).toBe(600);
    expect(find(rows, 'DELIVERY_DISTANCE')?.strikethroughMinor).toBeUndefined();
    expect(() => assertBreakdownAddsUp(rows)).not.toThrow();
  });

  it('strikes the delivery fee through for a discount that applied to it', () => {
    // A "free delivery" coupon belongs on the delivery row, not taken off the
    // food — the engine allocates the two separately and this follows it.
    const rows = buildOrderBreakdown(
      quote({
        discountMinor: 500,
        deliveryFeeMinor: 500,
        totalMinor: 6000,
        vatMinor: 783,
        taxableBaseMinor: 5217,
        fees: [
          {
            kind: 'DELIVERY',
            label: 'Delivery fee',
            grossMinor: 500,
            discountMinor: 500,
            taxableBaseMinor: 0,
            vatMinor: 0,
            totalMinor: 0,
            taxable: true,
          },
        ],
      }),
      delivery({ chargeableKm: 0, distanceFeeMinor: 0, deliveryFeeMinor: 500, distanceKm: 3 }),
    );

    expect(find(rows, 'DELIVERY_BASE')?.amountMinor).toBe(0);
    expect(find(rows, 'DELIVERY_BASE')?.strikethroughMinor).toBe(500);
    expect(find(rows, 'ITEMS')?.strikethroughMinor).toBeUndefined();
  });

  it('keeps a delivery fee that has no delivery quote behind it', () => {
    // An order placed before this feature existed. Dropping the row would make
    // the list stop adding up, which is worse than an unexplained line.
    const rows = buildOrderBreakdown(
      quote({ deliveryFeeMinor: 700, totalMinor: 6700, vatMinor: 874, taxableBaseMinor: 5826 }),
      null,
    );

    expect(find(rows, 'DELIVERY_BASE')?.amountMinor).toBe(700);
    expect(find(rows, 'DELIVERY_BASE')?.detail).toBeNull();
  });

  it('lists each custom charge by its own name', () => {
    const rows = buildOrderBreakdown(
      quote({
        chargesMinor: 300,
        totalMinor: 6300,
        vatMinor: 822,
        taxableBaseMinor: 5478,
        fees: [
          {
            kind: 'CHARGE',
            label: 'Packaging',
            grossMinor: 300,
            discountMinor: 0,
            taxableBaseMinor: 261,
            vatMinor: 39,
            totalMinor: 300,
            taxable: true,
          },
        ],
      }),
      null,
    );

    expect(find(rows, 'CHARGE')?.label).toBe('Packaging');
    expect(find(rows, 'CHARGE')?.amountMinor).toBe(300);
  });
});

describe('assertBreakdownAddsUp', () => {
  it('accepts a breakdown whose rows reconstruct the total', () => {
    const rows = buildOrderBreakdown(
      quote({ deliveryFeeMinor: 1100, totalMinor: 7100, vatMinor: 926, taxableBaseMinor: 6174 }),
      delivery(),
    );

    expect(() => assertBreakdownAddsUp(rows)).not.toThrow();
  });

  it('accepts one with a discount', () => {
    const rows = buildOrderBreakdown(
      quote({
        discountMinor: 1000,
        totalMinor: 5000,
        vatMinor: 652,
        taxableBaseMinor: 4348,
        lines: [{ lineDiscountMinor: 1000 }],
      }),
      null,
    );

    expect(() => assertBreakdownAddsUp(rows)).not.toThrow();
  });

  it('refuses a breakdown whose rows do not reach its total', () => {
    // The failure this exists to catch: a fee that reaches the total but never
    // gets a row, so the customer sees a list that is short by its amount.
    const rows = buildOrderBreakdown(
      quote({ totalMinor: 9999, vatMinor: 783, taxableBaseMinor: 5217 }),
      null,
    );

    expect(() => assertBreakdownAddsUp(rows)).toThrow(/does not add up/);
  });

  it('refuses a breakdown with no total at all', () => {
    expect(() => assertBreakdownAddsUp([])).toThrow(/no total/);
  });
});
