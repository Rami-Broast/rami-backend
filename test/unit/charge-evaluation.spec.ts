import { ChargeAppliesTo, ChargeType, OrderType, PaymentMethod } from '@prisma/client';

import { ChargeContext, ChargeRecord, evaluateCharges } from '../../src/charges/charge-evaluation';

function record(partial: Partial<ChargeRecord> = {}): ChargeRecord {
  return {
    id: 'charge-1',
    name: 'Service Fee',
    nameAr: null,
    type: ChargeType.FIXED,
    appliesTo: ChargeAppliesTo.SUBTOTAL,
    amountMinor: 500,
    percentBps: null,
    taxable: true,
    taxClass: 'STANDARD',
    branchIds: null,
    conditions: null,
    priority: 0,
    startsAt: null,
    endsAt: null,
    isActive: true,
    ...partial,
  };
}

function ctx(partial: Partial<ChargeContext> = {}): ChargeContext {
  return {
    branchId: 'branch-1',
    subtotalMinor: 10_000,
    deliveryFeeMinor: 500,
    itemCount: 3,
    orderType: OrderType.DELIVERY,
    paymentMethod: PaymentMethod.CARD,
    at: new Date('2026-06-15T12:00:00Z'),
    ...partial,
  };
}

describe('evaluateCharges', () => {
  describe('filtering', () => {
    it('excludes inactive charges', () => {
      const result = evaluateCharges([record({ isActive: false })], ctx());
      expect(result).toHaveLength(0);
    });

    it('excludes charges before startsAt', () => {
      const result = evaluateCharges(
        [record({ startsAt: new Date('2026-07-01T00:00:00Z') })],
        ctx({ at: new Date('2026-06-15T12:00:00Z') }),
      );
      expect(result).toHaveLength(0);
    });

    it('includes charges at exactly startsAt', () => {
      const result = evaluateCharges(
        [record({ startsAt: new Date('2026-06-15T12:00:00Z') })],
        ctx({ at: new Date('2026-06-15T12:00:00Z') }),
      );
      expect(result).toHaveLength(1);
    });

    it('excludes charges at or after endsAt', () => {
      const result = evaluateCharges(
        [record({ endsAt: new Date('2026-06-15T12:00:00Z') })],
        ctx({ at: new Date('2026-06-15T12:00:00Z') }),
      );
      expect(result).toHaveLength(0);
    });

    it('includes charges before endsAt', () => {
      const result = evaluateCharges(
        [record({ endsAt: new Date('2026-06-16T00:00:00Z') })],
        ctx({ at: new Date('2026-06-15T12:00:00Z') }),
      );
      expect(result).toHaveLength(1);
    });

    it('excludes charges scoped to other branches', () => {
      const result = evaluateCharges(
        [record({ branchIds: ['branch-2', 'branch-3'] })],
        ctx({ branchId: 'branch-1' }),
      );
      expect(result).toHaveLength(0);
    });

    it('includes charges scoped to the matching branch', () => {
      const result = evaluateCharges(
        [record({ branchIds: ['branch-1', 'branch-2'] })],
        ctx({ branchId: 'branch-1' }),
      );
      expect(result).toHaveLength(1);
    });

    it('includes charges with null branchIds (all branches)', () => {
      const result = evaluateCharges([record({ branchIds: null })], ctx());
      expect(result).toHaveLength(1);
    });

    it('includes charges with empty branchIds (all branches)', () => {
      const result = evaluateCharges([record({ branchIds: [] })], ctx());
      expect(result).toHaveLength(1);
    });

    it('excludes charges with non-matching orderType condition', () => {
      const result = evaluateCharges(
        [record({ conditions: { orderTypes: ['PICKUP'] } })],
        ctx({ orderType: OrderType.DELIVERY }),
      );
      expect(result).toHaveLength(0);
    });

    it('includes charges with matching orderType condition', () => {
      const result = evaluateCharges(
        [record({ conditions: { orderTypes: ['DELIVERY', 'PICKUP'] } })],
        ctx({ orderType: OrderType.DELIVERY }),
      );
      expect(result).toHaveLength(1);
    });

    it('excludes charges below minSubtotalMinor', () => {
      const result = evaluateCharges(
        [record({ conditions: { minSubtotalMinor: 20_000 } })],
        ctx({ subtotalMinor: 10_000 }),
      );
      expect(result).toHaveLength(0);
    });

    it('includes charges at exactly minSubtotalMinor', () => {
      const result = evaluateCharges(
        [record({ conditions: { minSubtotalMinor: 10_000 } })],
        ctx({ subtotalMinor: 10_000 }),
      );
      expect(result).toHaveLength(1);
    });

    it('excludes charges above maxSubtotalMinor', () => {
      const result = evaluateCharges(
        [record({ conditions: { maxSubtotalMinor: 5_000 } })],
        ctx({ subtotalMinor: 10_000 }),
      );
      expect(result).toHaveLength(0);
    });

    it('includes charges at exactly maxSubtotalMinor', () => {
      const result = evaluateCharges(
        [record({ conditions: { maxSubtotalMinor: 10_000 } })],
        ctx({ subtotalMinor: 10_000 }),
      );
      expect(result).toHaveLength(1);
    });

    it('excludes charges with non-matching paymentMethod', () => {
      const result = evaluateCharges(
        [record({ conditions: { paymentMethods: ['CASH_ON_DELIVERY'] } })],
        ctx({ paymentMethod: PaymentMethod.CARD }),
      );
      expect(result).toHaveLength(0);
    });

    it('includes charges with matching paymentMethod', () => {
      const result = evaluateCharges(
        [record({ conditions: { paymentMethods: ['CARD'] } })],
        ctx({ paymentMethod: PaymentMethod.CARD }),
      );
      expect(result).toHaveLength(1);
    });

    it('includes charges when paymentMethod condition set but ctx has none', () => {
      const result = evaluateCharges(
        [record({ conditions: { paymentMethods: ['ONLINE'] } })],
        ctx({ paymentMethod: undefined }),
      );
      expect(result).toHaveLength(1);
    });
  });

  describe('resolution', () => {
    it('resolves FIXED charge', () => {
      const result = evaluateCharges([record({ type: ChargeType.FIXED, amountMinor: 300 })], ctx());
      expect(result).toHaveLength(1);
      expect(result[0].amountMinor).toBe(300);
    });

    it('resolves FIXED charge with null amountMinor as 0', () => {
      const result = evaluateCharges(
        [record({ type: ChargeType.FIXED, amountMinor: null })],
        ctx(),
      );
      expect(result[0].amountMinor).toBe(0);
    });

    it('resolves PERCENTAGE charge on subtotal', () => {
      const result = evaluateCharges(
        [
          record({
            type: ChargeType.PERCENTAGE,
            appliesTo: ChargeAppliesTo.SUBTOTAL,
            percentBps: 500,
          }),
        ],
        ctx({ subtotalMinor: 10_000 }),
      );
      expect(result[0].amountMinor).toBe(500);
    });

    it('resolves PERCENTAGE charge on delivery fee', () => {
      const result = evaluateCharges(
        [
          record({
            type: ChargeType.PERCENTAGE,
            appliesTo: ChargeAppliesTo.DELIVERY,
            percentBps: 1000,
          }),
        ],
        ctx({ deliveryFeeMinor: 2_000 }),
      );
      expect(result[0].amountMinor).toBe(200);
    });

    it('rounds PERCENTAGE to nearest integer', () => {
      const result = evaluateCharges(
        [
          record({
            type: ChargeType.PERCENTAGE,
            appliesTo: ChargeAppliesTo.SUBTOTAL,
            percentBps: 333,
          }),
        ],
        ctx({ subtotalMinor: 10_000 }),
      );
      expect(result[0].amountMinor).toBe(Math.round((10_000 * 333) / 10_000));
    });

    it('resolves PER_ITEM charge', () => {
      const result = evaluateCharges(
        [record({ type: ChargeType.PER_ITEM, amountMinor: 100 })],
        ctx({ itemCount: 5 }),
      );
      expect(result[0].amountMinor).toBe(500);
    });

    it('resolves PER_ITEM with null amountMinor as 0', () => {
      const result = evaluateCharges(
        [record({ type: ChargeType.PER_ITEM, amountMinor: null })],
        ctx({ itemCount: 5 }),
      );
      expect(result[0].amountMinor).toBe(0);
    });

    it('maps charge fields to ResolvedCharge', () => {
      const result = evaluateCharges(
        [
          record({
            id: 'c-1',
            name: 'Packaging',
            nameAr: 'تغليف',
            taxable: false,
            taxClass: 'ZERO_RATED',
          }),
        ],
        ctx(),
      );
      expect(result[0]).toEqual({
        chargeId: 'c-1',
        name: 'Packaging',
        nameAr: 'تغليف',
        amountMinor: 500,
        taxable: false,
        taxClass: 'ZERO_RATED',
      });
    });

    it('maps null nameAr to undefined', () => {
      const result = evaluateCharges([record({ nameAr: null })], ctx());
      expect(result[0].nameAr).toBeUndefined();
    });
  });

  describe('ordering', () => {
    it('sorts results by priority ascending', () => {
      const charges = [
        record({ id: 'c-high', priority: 10, name: 'Late' }),
        record({ id: 'c-low', priority: 1, name: 'Early' }),
        record({ id: 'c-mid', priority: 5, name: 'Middle' }),
      ];
      const result = evaluateCharges(charges, ctx());
      expect(result.map((r) => r.chargeId)).toEqual(['c-low', 'c-mid', 'c-high']);
    });
  });

  describe('empty input', () => {
    it('returns empty array for no charges', () => {
      expect(evaluateCharges([], ctx())).toEqual([]);
    });

    it('returns empty array when all charges are filtered out', () => {
      const result = evaluateCharges(
        [record({ isActive: false }), record({ branchIds: ['other'] })],
        ctx(),
      );
      expect(result).toEqual([]);
    });
  });

  describe('combined conditions', () => {
    it('ANDs all conditions together', () => {
      const charge = record({
        branchIds: ['branch-1'],
        conditions: {
          orderTypes: ['DELIVERY'],
          minSubtotalMinor: 5_000,
          maxSubtotalMinor: 20_000,
          paymentMethods: ['CARD'],
        },
        startsAt: new Date('2026-01-01T00:00:00Z'),
        endsAt: new Date('2026-12-31T00:00:00Z'),
      });

      const result = evaluateCharges([charge], ctx());
      expect(result).toHaveLength(1);
    });

    it('rejects if any one condition fails', () => {
      const charge = record({
        branchIds: ['branch-1'],
        conditions: {
          orderTypes: ['PICKUP'],
          minSubtotalMinor: 5_000,
        },
      });

      const result = evaluateCharges([charge], ctx({ orderType: OrderType.DELIVERY }));
      expect(result).toHaveLength(0);
    });
  });
});
