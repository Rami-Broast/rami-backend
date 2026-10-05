import { Prisma } from '@prisma/client';

import {
  addVatExclusive,
  allocateProportionally,
  applyRate,
  assertMinor,
  formatMinor,
  roundHalfAwayFromZero,
  splitVatInclusive,
  sumMinor,
} from '../../src/common/money';

const VAT_15 = new Prisma.Decimal('0.15');

describe('money', () => {
  describe('assertMinor', () => {
    it.each([1.5, 0.1, -2.7, Number.NaN])('rejects the non-integer %p', (value) => {
      expect(() => assertMinor(value)).toThrow(/integer/);
    });

    it('rejects an amount beyond the safe integer range', () => {
      expect(() => assertMinor(Number.MAX_SAFE_INTEGER + 2)).toThrow();
    });

    it('accepts whole amounts including zero and negatives', () => {
      expect(() => assertMinor(0)).not.toThrow();
      expect(() => assertMinor(-500)).not.toThrow();
    });
  });

  describe('roundHalfAwayFromZero', () => {
    it('rounds a positive half up', () => {
      expect(roundHalfAwayFromZero(0.5)).toBe(1);
      expect(roundHalfAwayFromZero(2.5)).toBe(3);
    });

    it('rounds a negative half down, mirroring the positive case', () => {
      // Math.round(-0.5) is -0, which makes a refund differ from its charge by
      // a halala. This is the behaviour that prevents that.
      expect(roundHalfAwayFromZero(-0.5)).toBe(-1);
      expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
    });

    it('is symmetric about zero', () => {
      for (const value of [0.5, 1.5, 2.5, 3.14, 99.999]) {
        expect(roundHalfAwayFromZero(-value)).toBe(-roundHalfAwayFromZero(value));
      }
    });
  });

  describe('applyRate', () => {
    it('applies 15% to a round amount', () => {
      expect(applyRate(10_000, VAT_15)).toBe(1500);
    });

    it('rounds the result to whole minor units', () => {
      // 3333 x 0.15 = 499.95
      expect(applyRate(3333, VAT_15)).toBe(500);
    });

    it('avoids binary floating point error', () => {
      // 0.1 + 0.2 !== 0.3 in float; Decimal arithmetic keeps this exact.
      expect(applyRate(70, new Prisma.Decimal('0.1'))).toBe(7);
      expect(applyRate(2000, new Prisma.Decimal('0.07'))).toBe(140);
    });

    it('rejects a non-integer amount', () => {
      expect(() => applyRate(10.5, VAT_15)).toThrow(/integer/);
    });
  });

  describe('splitVatInclusive', () => {
    it('backs 15% out of a VAT-inclusive amount', () => {
      // 11500 gross at 15% => 10000 net + 1500 tax
      expect(splitVatInclusive(11_500, VAT_15)).toEqual({ netMinor: 10_000, vatMinor: 1500 });
    });

    it('always reconciles: net + vat === gross', () => {
      // Every awkward amount must still add up exactly.
      for (let gross = 0; gross <= 2000; gross += 7) {
        const { netMinor, vatMinor } = splitVatInclusive(gross, VAT_15);
        expect(netMinor + vatMinor).toBe(gross);
      }
    });

    it('handles a gross of zero', () => {
      expect(splitVatInclusive(0, VAT_15)).toEqual({ netMinor: 0, vatMinor: 0 });
    });

    it('handles the smallest possible charge', () => {
      const { netMinor, vatMinor } = splitVatInclusive(1, VAT_15);
      expect(netMinor + vatMinor).toBe(1);
    });
  });

  describe('addVatExclusive', () => {
    it('adds 15% on top', () => {
      expect(addVatExclusive(10_000, VAT_15)).toEqual({ grossMinor: 11_500, vatMinor: 1500 });
    });

    it('always reconciles: net + vat === gross', () => {
      for (let net = 0; net <= 2000; net += 7) {
        const { grossMinor, vatMinor } = addVatExclusive(net, VAT_15);
        expect(net + vatMinor).toBe(grossMinor);
      }
    });
  });

  describe('allocateProportionally', () => {
    it('splits evenly when weights are equal', () => {
      expect(allocateProportionally(300, [1, 1, 1])).toEqual([100, 100, 100]);
    });

    it('splits in proportion to weights', () => {
      expect(allocateProportionally(1000, [1, 3])).toEqual([250, 750]);
    });

    it('distributes an indivisible remainder without losing a unit', () => {
      const parts = allocateProportionally(100, [1, 1, 1]);

      // 100/3 does not divide evenly; the parts must still sum to 100 exactly.
      expect(sumMinor(parts)).toBe(100);
      expect(parts.sort()).toEqual([33, 33, 34]);
    });

    it('never loses or invents a unit, across many awkward splits', () => {
      // This is the property that keeps a discounted invoice reconcilable
      // against the payment taken for it.
      for (let total = 0; total < 500; total += 1) {
        for (const weights of [
          [1, 1, 1],
          [1, 2, 7],
          [5, 5],
          [1, 1, 1, 1, 1, 1, 1],
        ]) {
          expect(sumMinor(allocateProportionally(total, weights))).toBe(total);
        }
      }
    });

    it('gives the remainder to the largest fractional parts', () => {
      // 10 split by [1,1,8]: exact shares are 1, 1, 8 — no remainder.
      expect(allocateProportionally(10, [1, 1, 8])).toEqual([1, 1, 8]);
      // 11 split by [1,1,1]: 3.67 each, so two lines get the extra unit.
      expect(sumMinor(allocateProportionally(11, [1, 1, 1]))).toBe(11);
    });

    it('allocates nothing when the total is zero', () => {
      expect(allocateProportionally(0, [3, 7])).toEqual([0, 0]);
    });

    it('allocates nothing when every weight is zero', () => {
      expect(allocateProportionally(500, [0, 0])).toEqual([0, 0]);
    });

    it('returns an empty allocation for no weights', () => {
      expect(allocateProportionally(100, [])).toEqual([]);
    });

    it('rejects a negative weight', () => {
      expect(() => allocateProportionally(100, [1, -1])).toThrow(/negative/);
    });

    it('is deterministic', () => {
      const first = allocateProportionally(1000, [7, 11, 13]);
      const second = allocateProportionally(1000, [7, 11, 13]);

      expect(first).toEqual(second);
    });
  });

  describe('sumMinor', () => {
    it('sums integer amounts', () => {
      expect(sumMinor([100, 250, 3])).toBe(353);
    });

    it('sums an empty list to zero', () => {
      expect(sumMinor([])).toBe(0);
    });

    it('rejects a non-integer member', () => {
      expect(() => sumMinor([100, 2.5])).toThrow(/integer/);
    });
  });

  describe('formatMinor', () => {
    it.each([
      [3250, '32.50'],
      [100, '1.00'],
      [5, '0.05'],
      [0, '0.00'],
      [-3250, '-32.50'],
      [-5, '-0.05'],
    ])('formats %i as %s', (amount, expected) => {
      expect(formatMinor(amount)).toBe(expected);
    });
  });
});
