import { BadRequestException } from '@nestjs/common';
import { TaxClass } from '@prisma/client';

import { sumMinor } from '../../src/common/money';
import { AppConfigService } from '../../src/config/app-config.service';
import { buildConfiguration } from '../../src/config/configuration';
import { validateEnv } from '../../src/config/env.validation';
import { PricingRequest, ResolvedLine } from '../../src/vat/pricing.types';
import { VatService } from '../../src/vat/vat.service';

function serviceWith(overrides: Record<string, string> = {}): VatService {
  const env = validateEnv({
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    JWT_ACCESS_SECRET: 'a-test-signing-key-of-sufficient-length',
    ...overrides,
  });

  return new VatService(new AppConfigService(buildConfiguration(env)));
}

function line(partial: Partial<ResolvedLine> = {}): ResolvedLine {
  return {
    productId: 'product-1',
    productName: 'Test Product',
    unitPriceMinor: 11_500,
    quantity: 1,
    taxClass: TaxClass.STANDARD,
    addons: [],
    ...partial,
  };
}

function request(partial: Partial<PricingRequest> = {}): PricingRequest {
  return {
    currency: 'SAR',
    lines: [line()],
    deliveryFeeMinor: 0,
    ...partial,
  };
}

describe('VatService', () => {
  const vat = serviceWith();

  describe('VAT-inclusive pricing at 15%', () => {
    it('backs the tax out of a single item', () => {
      // 115.00 inclusive = 100.00 net + 15.00 VAT
      const quote = vat.price(request());

      expect(quote.totalMinor).toBe(11_500);
      expect(quote.taxableBaseMinor).toBe(10_000);
      expect(quote.vatMinor).toBe(1500);
      expect(quote.vatRate.toString()).toBe('0.15');
    });

    it('does not add tax on top of an inclusive price', () => {
      // The customer pays the menu price. This is the whole point of inclusive
      // pricing, and getting it wrong overcharges every order by 15%.
      const quote = vat.price(request());

      expect(quote.totalMinor).toBe(11_500);
    });

    it('scales with quantity', () => {
      const quote = vat.price(request({ lines: [line({ quantity: 3 })] }));

      expect(quote.subtotalMinor).toBe(34_500);
      expect(quote.totalMinor).toBe(34_500);
      expect(quote.taxableBaseMinor + quote.vatMinor).toBe(quote.totalMinor);
    });

    it('includes add-ons in the taxed amount', () => {
      const quote = vat.price(
        request({
          lines: [
            line({
              unitPriceMinor: 10_000,
              quantity: 2,
              addons: [
                {
                  addonId: 'addon-1',
                  modifierGroupName: 'Extras',
                  addonName: 'Extra cheese',
                  unitPriceMinor: 500,
                  taxClass: TaxClass.STANDARD,
                  quantity: 1,
                },
              ],
            }),
          ],
        }),
      );

      // (10000 + 500) x 2 = 21000
      expect(quote.subtotalMinor).toBe(21_000);
      expect(quote.totalMinor).toBe(21_000);
    });
  });

  describe('VAT-exclusive pricing', () => {
    const exclusive = serviceWith({ PRICES_INCLUDE_VAT: 'false' });

    it('adds tax on top', () => {
      const quote = exclusive.price(request({ lines: [line({ unitPriceMinor: 10_000 })] }));

      expect(quote.taxableBaseMinor).toBe(10_000);
      expect(quote.vatMinor).toBe(1500);
      expect(quote.totalMinor).toBe(11_500);
    });
  });

  describe('tax classes', () => {
    it('charges no VAT on a zero-rated item', () => {
      const quote = vat.price(request({ lines: [line({ taxClass: TaxClass.ZERO_RATED })] }));

      expect(quote.vatMinor).toBe(0);
      expect(quote.taxableBaseMinor).toBe(11_500);
      expect(quote.totalMinor).toBe(11_500);
    });

    it('charges no VAT on an exempt item', () => {
      const quote = vat.price(request({ lines: [line({ taxClass: TaxClass.EXEMPT })] }));

      expect(quote.vatMinor).toBe(0);
    });

    it('taxes a mixed basket per line, not per order', () => {
      const quote = vat.price(
        request({
          lines: [
            line({ productId: 'a', unitPriceMinor: 11_500, taxClass: TaxClass.STANDARD }),
            line({ productId: 'b', unitPriceMinor: 5000, taxClass: TaxClass.ZERO_RATED }),
          ],
        }),
      );

      expect(quote.lines[0].lineVatMinor).toBe(1500);
      expect(quote.lines[1].lineVatMinor).toBe(0);
      expect(quote.vatMinor).toBe(1500);
      expect(quote.totalMinor).toBe(16_500);
    });
  });

  describe('delivery fee', () => {
    it('taxes the fee as part of the supply by default', () => {
      const quote = vat.price(request({ deliveryFeeMinor: 1150 }));

      expect(quote.fees).toHaveLength(1);
      expect(quote.fees[0].taxable).toBe(true);
      expect(quote.fees[0].vatMinor).toBe(150);
      expect(quote.totalMinor).toBe(12_650);
    });

    it('leaves the fee untaxed when configured that way', () => {
      const untaxed = serviceWith({ DELIVERY_FEE_TAXABLE: 'false' });

      const quote = untaxed.price(request({ deliveryFeeMinor: 1150 }));

      expect(quote.fees[0].taxable).toBe(false);
      expect(quote.fees[0].vatMinor).toBe(0);
      expect(quote.vatMinor).toBe(1500);
    });

    it('adds no fee line for pickup', () => {
      const quote = vat.price(request({ deliveryFeeMinor: 0 }));

      expect(quote.fees).toHaveLength(0);
    });
  });

  describe('discounts', () => {
    it('reduces the taxable base rather than being taken off the total after tax', () => {
      const quote = vat.price(
        request({
          lines: [line({ unitPriceMinor: 11_500 })],
          discounts: [{ source: 'TEST10', amountMinor: 1150 }],
        }),
      );

      // 11500 − 1150 = 10350 inclusive => 9000 net + 1350 VAT
      expect(quote.discountMinor).toBe(1150);
      expect(quote.totalMinor).toBe(10_350);
      expect(quote.taxableBaseMinor).toBe(9000);
      expect(quote.vatMinor).toBe(1350);
    });

    it('applies a stacked promotion and coupon together, both off the same gross', () => {
      // Owner decision, 2026-09-10: a customer who qualifies for a standing
      // offer *and* holds a code gets both. Nothing compounds — each amount was
      // resolved against the undiscounted gross, so two 10% discounts on 115.00
      // take 23.00 off and not 21.85.
      const quote = vat.price(
        request({
          lines: [line({ unitPriceMinor: 11_500 })],
          discounts: [
            { source: 'SUMMER', amountMinor: 1150 },
            { source: 'TEST10', amountMinor: 1150 },
          ],
        }),
      );

      expect(quote.discountMinor).toBe(2300);
      expect(quote.itemDiscountMinor).toBe(2300);
      expect(quote.totalMinor).toBe(9200);
    });

    it('clamps a stacked pair to the basket rather than paying the customer to order', () => {
      const quote = vat.price(
        request({
          lines: [line({ unitPriceMinor: 3000 })],
          discounts: [
            { source: 'HALF', amountMinor: 2000 },
            { source: 'ALSOHALF', amountMinor: 2000 },
          ],
        }),
      );

      // Two discounts worth 40.00 on a 30.00 basket take it to zero and no
      // further. `itemDiscountMinor` is what a caller recording each discount
      // has to share out — recording what they asked for would book a 40.00
      // giveaway that never happened.
      expect(quote.itemDiscountMinor).toBe(3000);
      expect(quote.discountMinor).toBe(3000);
      expect(quote.totalMinor).toBe(0);
      expect(quote.vatMinor).toBe(0);
    });

    it('clamps the two buckets separately, because they apply to different things', () => {
      const quote = vat.price(
        request({
          lines: [line({ unitPriceMinor: 3000 })],
          deliveryFeeMinor: 800,
          discounts: [
            { source: 'FREEDELIVERY', amountMinor: 5000, appliesToDeliveryFee: true },
            { source: 'TEN', amountMinor: 1000 },
          ],
        }),
      );

      // A free-delivery coupon worth more than the fee does not spill over onto
      // the food, and a food discount does not pay for the delivery.
      expect(quote.deliveryDiscountMinor).toBe(800);
      expect(quote.itemDiscountMinor).toBe(1000);
      expect(quote.discountMinor).toBe(1800);
    });

    it('splits a discount across lines so the parts sum exactly', () => {
      const quote = vat.price(
        request({
          lines: [
            line({ productId: 'a', unitPriceMinor: 1000 }),
            line({ productId: 'b', unitPriceMinor: 2000 }),
            line({ productId: 'c', unitPriceMinor: 3000 }),
          ],
          discounts: [{ source: 'TEST', amountMinor: 100 }],
        }),
      );

      const allocated = sumMinor(quote.lines.map((l) => l.lineDiscountMinor));

      expect(allocated).toBe(100);
      expect(quote.discountMinor).toBe(100);
    });

    it('splits an indivisible discount without losing a halala', () => {
      const quote = vat.price(
        request({
          lines: [
            line({ productId: 'a', unitPriceMinor: 1000 }),
            line({ productId: 'b', unitPriceMinor: 1000 }),
            line({ productId: 'c', unitPriceMinor: 1000 }),
          ],
          discounts: [{ source: 'TEST', amountMinor: 100 }],
        }),
      );

      // 100 across three equal lines does not divide evenly.
      expect(sumMinor(quote.lines.map((l) => l.lineDiscountMinor))).toBe(100);
    });

    it('never lets a discount exceed the basket', () => {
      const quote = vat.price(
        request({
          lines: [line({ unitPriceMinor: 1000 })],
          discounts: [{ source: 'HUGE', amountMinor: 999_999 }],
        }),
      );

      // Otherwise the platform would be paying the customer to order.
      expect(quote.totalMinor).toBe(0);
      expect(quote.discountMinor).toBe(1000);
    });

    it('applies a delivery-only discount to the fee, not the items', () => {
      const quote = vat.price(
        request({
          lines: [line({ unitPriceMinor: 11_500 })],
          deliveryFeeMinor: 1150,
          discounts: [{ source: 'FREEDEL', amountMinor: 1150, appliesToDeliveryFee: true }],
        }),
      );

      expect(quote.fees[0].totalMinor).toBe(0);
      expect(quote.lines[0].lineTotalMinor).toBe(11_500);
      expect(quote.totalMinor).toBe(11_500);
    });

    it('caps a delivery discount at the fee', () => {
      const quote = vat.price(
        request({
          deliveryFeeMinor: 1000,
          discounts: [{ source: 'FREEDEL', amountMinor: 5000, appliesToDeliveryFee: true }],
        }),
      );

      expect(quote.discountMinor).toBe(1000);
      expect(quote.totalMinor).toBe(11_500);
    });
  });

  describe('invariants', () => {
    it('always satisfies taxable base + VAT === total', () => {
      // Awkward prices and quantities are where rounding drift would appear.
      for (const unitPriceMinor of [1, 7, 33, 99, 333, 1234, 9999, 10_001]) {
        for (const quantity of [1, 2, 3, 7]) {
          for (const deliveryFeeMinor of [0, 1, 999, 1150]) {
            const quote = vat.price(
              request({
                lines: [line({ unitPriceMinor, quantity })],
                deliveryFeeMinor,
              }),
            );

            expect(quote.taxableBaseMinor + quote.vatMinor).toBe(quote.totalMinor);
          }
        }
      }
    });

    it('always satisfies sum(components) === total', () => {
      for (const discount of [0, 1, 17, 500, 3333]) {
        const quote = vat.price(
          request({
            lines: [
              line({ productId: 'a', unitPriceMinor: 3333, quantity: 3 }),
              line({ productId: 'b', unitPriceMinor: 7777, quantity: 2 }),
            ],
            deliveryFeeMinor: 1150,
            discounts: [{ source: 'X', amountMinor: discount }],
          }),
        );

        const components =
          sumMinor(quote.lines.map((l) => l.lineTotalMinor)) +
          sumMinor(quote.fees.map((f) => f.totalMinor));

        expect(components).toBe(quote.totalMinor);
      }
    });

    it('never produces a negative total', () => {
      const quote = vat.price(
        request({
          lines: [line({ unitPriceMinor: 1 })],
          discounts: [{ source: 'X', amountMinor: 100_000 }],
        }),
      );

      expect(quote.totalMinor).toBeGreaterThanOrEqual(0);
    });

    it('snapshots the rate onto every line', () => {
      const quote = vat.price(
        request({ lines: [line({ productId: 'a' }), line({ productId: 'b' })] }),
      );

      for (const priced of quote.lines) {
        expect(priced.vatRate.toString()).toBe('0.15');
      }
    });
  });

  describe('rejected input', () => {
    it('refuses an empty basket', () => {
      expect(() => vat.price(request({ lines: [] }))).toThrow(BadRequestException);
    });

    it.each([0, -1, 1.5])('refuses quantity %p', (quantity) => {
      expect(() => vat.price(request({ lines: [line({ quantity })] }))).toThrow(
        BadRequestException,
      );
    });

    it('refuses an implausible quantity', () => {
      expect(() => vat.price(request({ lines: [line({ quantity: 100_000 })] }))).toThrow(
        BadRequestException,
      );
    });

    it('refuses a negative price', () => {
      expect(() => vat.price(request({ lines: [line({ unitPriceMinor: -100 })] }))).toThrow(
        BadRequestException,
      );
    });

    it('refuses a negative delivery fee', () => {
      expect(() => vat.price(request({ deliveryFeeMinor: -1 }))).toThrow(BadRequestException);
    });

    it('refuses a negative discount, which would be a hidden surcharge', () => {
      expect(() => vat.price(request({ discounts: [{ source: 'X', amountMinor: -500 }] }))).toThrow(
        BadRequestException,
      );
    });
  });

  describe('rate configuration', () => {
    it('uses the configured rate rather than a hard-coded one', () => {
      const atFivePercent = serviceWith({ VAT_STANDARD_RATE: '0.05' });

      const quote = atFivePercent.price(request({ lines: [line({ unitPriceMinor: 10_500 })] }));

      expect(quote.vatRate.toString()).toBe('0.05');
      expect(quote.taxableBaseMinor).toBe(10_000);
      expect(quote.vatMinor).toBe(500);
    });

    it('handles a zero rate without dividing by zero', () => {
      const zeroRated = serviceWith({ VAT_STANDARD_RATE: '0' });

      const quote = zeroRated.price(request({ lines: [line({ unitPriceMinor: 10_000 })] }));

      expect(quote.vatMinor).toBe(0);
      expect(quote.totalMinor).toBe(10_000);
    });
  });
});
