import { DiscountType, Prisma } from '@prisma/client';

import { applyRate, Minor } from '../common/money';
import { ResolvedDiscount } from '../vat/pricing.types';

/**
 * What an automatic promotion is worth on a cart, as a pure function.
 *
 * A promotion is the discount **nobody types a code for**. The owner publishes
 * it, and a cart that qualifies gets it at checkout without the customer doing
 * anything. That is the whole difference from a coupon, and it is why this file
 * exists rather than the promotion being routed through `evaluateCoupon`: a
 * coupon is claimed by one customer against usage limits, a promotion is a
 * standing price the branch is offering everybody.
 *
 * No database and no framework here, for the same reason coupon evaluation is
 * pure: every rounding edge and every "does this cart qualify" decision is
 * unit-testable, and what comes out is a `ResolvedDiscount` fed to the same VAT
 * engine as any other discount. A promotion never touches tax arithmetic.
 *
 * ## Two rules that decide money, and are deliberately conservative
 *
 * **Only one promotion applies to an order.** Two automatic discounts stacking
 * is how a basket ends up 60% off with nobody having approved 60% — and it is
 * invisible until the settlement report. When several qualify, the one worth
 * most to the customer wins ({@link selectBestPromotion}).
 *
 * **A promotion and a coupon never stack either**; the caller applies whichever
 * is worth more. See `OrdersService` — the customer is never charged more than
 * the better of the two, and is told when a code they typed lost to a standing
 * offer rather than being left to wonder why it did nothing.
 *
 * Both are **defaults chosen to fail safe, not owner decisions**. Stacking, and
 * an owner-ordered precedence, are both defensible products; neither has been
 * asked for. Change them here, in one place, when the owner says so.
 */

export interface PromotionInput {
  id: string;
  name: string;
  discountType: DiscountType;
  /** Percentage (e.g. 10 for 10%) or minor units, per `discountType`. */
  discountValue: Prisma.Decimal;
  maxDiscountMinor: number | null;
  /** Branches this promotion runs at. Empty means every branch. */
  branchIds: readonly string[];
  startsAt: Date;
  endsAt: Date;
  isActive: boolean;
  /** The owner's display ordering. Used here only to break a tie. */
  priority: number;
  /** Products this promotion is limited to. Empty means the whole basket. */
  productIds: readonly string[];
}

/** One cart line, reduced to the two facts a promotion needs. */
export interface PromotionCartLine {
  productId: string;
  /** Gross for the line, add-ons included, before any discount. */
  grossMinor: Minor;
}

export interface PromotionContext {
  branchId: string;
  lines: readonly PromotionCartLine[];
  /** Gross item total before discount — the sum of the lines' gross. */
  subtotalMinor: Minor;
  deliveryFeeMinor: Minor;
  now: Date;
}

export interface AppliedPromotion {
  promotionId: string;
  /**
   * The promotion's own name — "Two for Tuesday".
   *
   * Carried so the bill can say *what* took the money off. A customer who was
   * never asked for a code has no other way to know why the total moved, and an
   * unexplained discount gets queried exactly as often as an unexplained charge.
   */
  name: string;
  discountMinor: Minor;
  /**
   * The part of the basket the discount was measured against — the qualifying
   * lines, or the whole subtotal for a basket-wide promotion. Recorded so a
   * later dispute can reconstruct the arithmetic rather than re-derive it.
   */
  qualifyingSubtotalMinor: Minor;
  discount: ResolvedDiscount;
}

/**
 * The part of the cart a promotion is measured on.
 *
 * A promotion listing products is an offer **on those products**: "20% off
 * burgers" must not take 20% off the drinks that happen to be in the same
 * basket. A promotion listing none is a basket-wide offer and is measured on
 * the whole subtotal.
 */
function qualifyingSubtotal(promotion: PromotionInput, ctx: PromotionContext): Minor {
  if (promotion.productIds.length === 0) {
    return ctx.subtotalMinor;
  }

  const ids = new Set(promotion.productIds);
  return ctx.lines
    .filter((line) => ids.has(line.productId))
    .reduce((sum, line) => sum + line.grossMinor, 0);
}

/**
 * What one promotion is worth on this cart, or null if it does not apply.
 *
 * Returns null rather than a reason, unlike `evaluateCoupon`. Nobody asked for
 * this discount, so there is nobody to explain its absence to — telling a
 * customer why an offer they never invoked did not apply is noise on the one
 * screen where noise costs an order.
 */
export function evaluatePromotion(
  promotion: PromotionInput,
  ctx: PromotionContext,
): AppliedPromotion | null {
  if (!promotion.isActive) return null;
  if (ctx.now < promotion.startsAt || ctx.now >= promotion.endsAt) return null;
  if (promotion.branchIds.length > 0 && !promotion.branchIds.includes(ctx.branchId)) return null;

  const base = qualifyingSubtotal(promotion, ctx);

  // A promotion limited to products none of which are in the cart qualifies for
  // nothing. Checked on the qualifying subtotal rather than on product presence
  // so a zero-priced qualifying line cannot produce a zero discount that still
  // counts as "applied" and shuts out a promotion that would have paid.
  if (promotion.productIds.length > 0 && base <= 0) return null;

  const discountMinor = amountFor(promotion, ctx, base);

  if (discountMinor <= 0) return null;

  return {
    promotionId: promotion.id,
    name: promotion.name,
    discountMinor,
    qualifyingSubtotalMinor: base,
    discount: {
      // The source is what the breakdown records for audit. A promotion has no
      // code to quote, so it is identified by id — the name can be edited, the
      // id is what a report joins on.
      source: `promotion:${promotion.id}`,
      amountMinor: discountMinor,
      appliesToDeliveryFee: promotion.discountType === DiscountType.FREE_DELIVERY,
    },
  };
}

function amountFor(promotion: PromotionInput, ctx: PromotionContext, base: Minor): Minor {
  switch (promotion.discountType) {
    case DiscountType.PERCENTAGE: {
      const raw = applyRate(base, promotion.discountValue.div(100));
      const capped =
        promotion.maxDiscountMinor !== null ? Math.min(raw, promotion.maxDiscountMinor) : raw;
      return Math.min(capped, base);
    }
    case DiscountType.FIXED_AMOUNT:
      // Never more than the part of the basket it applies to: a 50 SAR promotion
      // on a 30 SAR qualifying line is 30 off, not 50 and a credit.
      return Math.min(Math.round(promotion.discountValue.toNumber()), base);
    case DiscountType.FREE_DELIVERY:
      return ctx.deliveryFeeMinor;
  }
}

/**
 * The one promotion that applies, out of every one that qualifies.
 *
 * **Largest discount wins.** That is the rule least likely to surprise anyone:
 * the customer is never quietly given the smaller of two offers they can both
 * see, and the owner cannot accidentally hand out a discount larger than any
 * single promotion they published.
 *
 * `priority` breaks a tie and nothing more. It is the owner's *display*
 * ordering today — the only thing it has ever meant — and quietly promoting it
 * to the field that decides money would change what every existing row means.
 */
export function selectBestPromotion(
  promotions: readonly PromotionInput[],
  ctx: PromotionContext,
): AppliedPromotion | null {
  const applicable = promotions
    .map((promotion) => ({ promotion, applied: evaluatePromotion(promotion, ctx) }))
    .filter(
      (entry): entry is { promotion: PromotionInput; applied: AppliedPromotion } =>
        entry.applied !== null,
    );

  if (applicable.length === 0) return null;

  applicable.sort((a, b) => {
    if (b.applied.discountMinor !== a.applied.discountMinor) {
      return b.applied.discountMinor - a.applied.discountMinor;
    }
    if (a.promotion.priority !== b.promotion.priority) {
      return a.promotion.priority - b.promotion.priority;
    }
    // Last resort, so the winner is stable across requests rather than left to
    // whatever order the database returned.
    return a.promotion.id.localeCompare(b.promotion.id);
  });

  return applicable[0].applied;
}
