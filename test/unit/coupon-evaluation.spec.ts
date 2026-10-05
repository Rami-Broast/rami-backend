import { CouponRuleType, DiscountType, Prisma } from '@prisma/client';

import {
  CouponContext,
  CouponInput,
  CouponRuleInput,
  evaluateCoupon,
} from '../../src/coupons/coupon-evaluation';

function coupon(partial: Partial<CouponInput> = {}): CouponInput {
  return {
    code: 'SAVE',
    discountType: DiscountType.PERCENTAGE,
    discountValue: new Prisma.Decimal(10),
    maxDiscountMinor: null,
    validFrom: new Date('2020-01-01T00:00:00Z'),
    validUntil: new Date('2999-01-01T00:00:00Z'),
    isActive: true,
    totalUsageLimit: null,
    perCustomerLimit: null,
    usageCount: 0,
    ...partial,
  };
}

function ctx(partial: Partial<CouponContext> = {}): CouponContext {
  return {
    customerId: 'cust-1',
    branchId: 'branch-1',
    subtotalMinor: 10_000,
    deliveryFeeMinor: 1500,
    productIds: ['p1'],
    categoryIds: ['c1'],
    isFirstOrder: true,
    customerUsageCount: 0,
    now: new Date('2026-06-15T12:00:00Z'),
    ...partial,
  };
}

describe('evaluateCoupon', () => {
  describe('discount computation', () => {
    it('applies a percentage discount', () => {
      const r = evaluateCoupon(coupon(), [], ctx());
      expect(r.ok && r.discountMinor).toBe(1000); // 10% of 10,000
    });

    it('caps a percentage discount at maxDiscountMinor', () => {
      const r = evaluateCoupon(
        coupon({ discountValue: new Prisma.Decimal(50), maxDiscountMinor: 2000 }),
        [],
        ctx(),
      );
      expect(r.ok && r.discountMinor).toBe(2000); // 50% would be 5,000, capped
    });

    it('applies a fixed amount, clamped to the subtotal', () => {
      const r = evaluateCoupon(
        coupon({
          discountType: DiscountType.FIXED_AMOUNT,
          discountValue: new Prisma.Decimal(99_999),
        }),
        [],
        ctx({ subtotalMinor: 3000 }),
      );
      expect(r.ok && r.discountMinor).toBe(3000);
    });

    it('applies free delivery against the delivery fee', () => {
      const r = evaluateCoupon(
        coupon({ discountType: DiscountType.FREE_DELIVERY, discountValue: new Prisma.Decimal(0) }),
        [],
        ctx({ deliveryFeeMinor: 1500 }),
      );
      expect(r.ok && r.discountMinor).toBe(1500);
      expect(r.ok && r.discount.appliesToDeliveryFee).toBe(true);
    });
  });

  describe('coupon-level validity', () => {
    it('rejects an inactive coupon', () => {
      const r = evaluateCoupon(coupon({ isActive: false }), [], ctx());
      expect(r.ok).toBe(false);
    });

    it('rejects outside the validity window', () => {
      const r = evaluateCoupon(coupon({ validUntil: new Date('2021-01-01T00:00:00Z') }), [], ctx());
      expect(r.ok).toBe(false);
    });

    it('rejects when the total usage limit is reached', () => {
      const r = evaluateCoupon(coupon({ totalUsageLimit: 5, usageCount: 5 }), [], ctx());
      expect(r.ok).toBe(false);
    });

    it('rejects when the per-customer limit is reached', () => {
      const r = evaluateCoupon(coupon({ perCustomerLimit: 1 }), [], ctx({ customerUsageCount: 1 }));
      expect(r.ok).toBe(false);
    });
  });

  describe('rules (ANDed)', () => {
    const first: CouponRuleInput = { ruleType: CouponRuleType.FIRST_ORDER, config: {} };

    it('enforces first-order', () => {
      expect(evaluateCoupon(coupon(), [first], ctx({ isFirstOrder: true })).ok).toBe(true);
      expect(evaluateCoupon(coupon(), [first], ctx({ isFirstOrder: false })).ok).toBe(false);
    });

    it('enforces minimum spend', () => {
      const rule: CouponRuleInput = {
        ruleType: CouponRuleType.MIN_SPEND,
        config: { minSpendMinor: 5000 },
      };
      expect(evaluateCoupon(coupon(), [rule], ctx({ subtotalMinor: 5000 })).ok).toBe(true);
      expect(evaluateCoupon(coupon(), [rule], ctx({ subtotalMinor: 4999 })).ok).toBe(false);
    });

    it('enforces branch eligibility', () => {
      const rule: CouponRuleInput = {
        ruleType: CouponRuleType.BRANCH,
        config: { branchIds: ['branch-1'] },
      };
      expect(evaluateCoupon(coupon(), [rule], ctx({ branchId: 'branch-1' })).ok).toBe(true);
      expect(evaluateCoupon(coupon(), [rule], ctx({ branchId: 'branch-2' })).ok).toBe(false);
    });

    it('enforces product and category presence', () => {
      const product: CouponRuleInput = {
        ruleType: CouponRuleType.PRODUCT,
        config: { productIds: ['p9'] },
      };
      expect(evaluateCoupon(coupon(), [product], ctx({ productIds: ['p1'] })).ok).toBe(false);
      expect(evaluateCoupon(coupon(), [product], ctx({ productIds: ['p9'] })).ok).toBe(true);

      const category: CouponRuleInput = {
        ruleType: CouponRuleType.CATEGORY,
        config: { categoryIds: ['c9'] },
      };
      expect(evaluateCoupon(coupon(), [category], ctx({ categoryIds: ['c1'] })).ok).toBe(false);
      expect(evaluateCoupon(coupon(), [category], ctx({ categoryIds: ['c9'] })).ok).toBe(true);
    });

    it('enforces customer eligibility', () => {
      const rule: CouponRuleInput = {
        ruleType: CouponRuleType.CUSTOMER_ELIGIBILITY,
        config: { customerIds: ['cust-1'] },
      };
      expect(evaluateCoupon(coupon(), [rule], ctx({ customerId: 'cust-1' })).ok).toBe(true);
      expect(evaluateCoupon(coupon(), [rule], ctx({ customerId: 'cust-2' })).ok).toBe(false);
    });

    it('fails if any one ANDed rule fails', () => {
      const rules: CouponRuleInput[] = [
        { ruleType: CouponRuleType.MIN_SPEND, config: { minSpendMinor: 1 } },
        { ruleType: CouponRuleType.BRANCH, config: { branchIds: ['other'] } },
      ];
      expect(evaluateCoupon(coupon(), rules, ctx()).ok).toBe(false);
    });
  });
});
