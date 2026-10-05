import { CouponRuleType, DiscountType, Prisma } from '@prisma/client';

import { applyRate, Minor } from '../common/money';
import { ResolvedDiscount } from '../vat/pricing.types';

/**
 * Coupon eligibility and discount, as a pure function.
 *
 * No database, no framework: given a coupon, its rules and a snapshot of the
 * cart/customer context, decide whether the coupon applies and what it is worth.
 * Keeping this pure means every rule and every rounding edge is unit-testable,
 * and the discount it returns is fed to the same VAT engine as any other
 * discount — a coupon can never touch tax arithmetic directly.
 *
 * Rules are ANDed: every rule attached to the coupon must pass.
 */

export interface CouponInput {
  code: string;
  discountType: DiscountType;
  /** Percentage (e.g. 10 for 10%) or minor units, per discountType. */
  discountValue: Prisma.Decimal;
  maxDiscountMinor: number | null;
  validFrom: Date;
  validUntil: Date;
  isActive: boolean;
  totalUsageLimit: number | null;
  perCustomerLimit: number | null;
  usageCount: number;
}

export interface CouponRuleInput {
  ruleType: CouponRuleType;
  config: unknown;
}

export interface CouponContext {
  customerId: string;
  branchId: string;
  /** Gross item total before discount, in minor units. */
  subtotalMinor: Minor;
  deliveryFeeMinor: Minor;
  productIds: readonly string[];
  categoryIds: readonly string[];
  /** True when this is the customer's first ever order. */
  isFirstOrder: boolean;
  /** How many times this customer has already used this coupon. */
  customerUsageCount: number;
  now: Date;
}

export type CouponEvaluation =
  { ok: true; discountMinor: Minor; discount: ResolvedDiscount } | { ok: false; reason: string };

function asRecord(config: unknown): Record<string, unknown> {
  return config && typeof config === 'object' ? (config as Record<string, unknown>) : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function ruleFails(rule: CouponRuleInput, ctx: CouponContext): string | null {
  const config = asRecord(rule.config);

  switch (rule.ruleType) {
    case CouponRuleType.FIRST_ORDER:
      return ctx.isFirstOrder ? null : 'This coupon is for a first order only.';

    case CouponRuleType.MIN_SPEND: {
      const min = typeof config.minSpendMinor === 'number' ? config.minSpendMinor : 0;
      return ctx.subtotalMinor >= min ? null : 'Your order is below this coupon’s minimum spend.';
    }

    case CouponRuleType.BRANCH: {
      const branchIds = asStringArray(config.branchIds);
      return branchIds.includes(ctx.branchId) ? null : 'This coupon is not valid at this branch.';
    }

    case CouponRuleType.PRODUCT: {
      const productIds = asStringArray(config.productIds);
      return ctx.productIds.some((id) => productIds.includes(id))
        ? null
        : 'This coupon requires a qualifying item in your cart.';
    }

    case CouponRuleType.CATEGORY: {
      const categoryIds = asStringArray(config.categoryIds);
      return ctx.categoryIds.some((id) => categoryIds.includes(id))
        ? null
        : 'This coupon requires an item from a qualifying category.';
    }

    case CouponRuleType.TIME_WINDOW: {
      // Optional day-of-week (0=Sunday) and minute-of-day window, in addition to
      // the coupon's own validFrom/validUntil dates.
      const days = Array.isArray(config.daysOfWeek)
        ? config.daysOfWeek.filter((d): d is number => typeof d === 'number')
        : null;
      if (days && !days.includes(ctx.now.getUTCDay())) {
        return 'This coupon is not valid today.';
      }
      const minuteOfDay = ctx.now.getUTCHours() * 60 + ctx.now.getUTCMinutes();
      const start = typeof config.startMinuteOfDay === 'number' ? config.startMinuteOfDay : null;
      const end = typeof config.endMinuteOfDay === 'number' ? config.endMinuteOfDay : null;
      if (start !== null && end !== null && (minuteOfDay < start || minuteOfDay > end)) {
        return 'This coupon is not valid at this time.';
      }
      return null;
    }

    case CouponRuleType.CUSTOMER_ELIGIBILITY: {
      const customerIds = asStringArray(config.customerIds);
      // An empty list means "no specific customers" — treat as not eligible,
      // since the rule was attached deliberately.
      return customerIds.includes(ctx.customerId)
        ? null
        : 'This coupon is not available on your account.';
    }
  }
}

/** Computes the discount a valid coupon is worth, in minor units. */
function discountFor(
  coupon: CouponInput,
  ctx: CouponContext,
): { minor: Minor; onDelivery: boolean } {
  switch (coupon.discountType) {
    case DiscountType.PERCENTAGE: {
      const raw = applyRate(ctx.subtotalMinor, coupon.discountValue.div(100));
      const capped =
        coupon.maxDiscountMinor !== null ? Math.min(raw, coupon.maxDiscountMinor) : raw;
      return { minor: Math.min(capped, ctx.subtotalMinor), onDelivery: false };
    }
    case DiscountType.FIXED_AMOUNT: {
      const value = Math.round(coupon.discountValue.toNumber());
      return { minor: Math.min(value, ctx.subtotalMinor), onDelivery: false };
    }
    case DiscountType.FREE_DELIVERY:
      return { minor: ctx.deliveryFeeMinor, onDelivery: true };
  }
}

export function evaluateCoupon(
  coupon: CouponInput,
  rules: readonly CouponRuleInput[],
  ctx: CouponContext,
): CouponEvaluation {
  if (!coupon.isActive) {
    return { ok: false, reason: 'This coupon is no longer active.' };
  }

  if (ctx.now < coupon.validFrom || ctx.now > coupon.validUntil) {
    return { ok: false, reason: 'This coupon has expired or is not yet valid.' };
  }

  if (coupon.totalUsageLimit !== null && coupon.usageCount >= coupon.totalUsageLimit) {
    return { ok: false, reason: 'This coupon has reached its usage limit.' };
  }

  if (coupon.perCustomerLimit !== null && ctx.customerUsageCount >= coupon.perCustomerLimit) {
    return { ok: false, reason: 'You have already used this coupon the maximum number of times.' };
  }

  for (const rule of rules) {
    const failure = ruleFails(rule, ctx);
    if (failure) {
      return { ok: false, reason: failure };
    }
  }

  const { minor, onDelivery } = discountFor(coupon, ctx);

  if (minor <= 0) {
    return { ok: false, reason: 'This coupon does not reduce your total.' };
  }

  return {
    ok: true,
    discountMinor: minor,
    discount: { source: coupon.code, amountMinor: minor, appliesToDeliveryFee: onDelivery },
  };
}
