import { DiscountType, Prisma } from '@prisma/client';

import {
  evaluatePromotion,
  PromotionContext,
  PromotionInput,
  selectBestPromotion,
} from '../../src/promotions/promotion-evaluation';

const BRANCH = 'branch-1';
const BURGER = 'product-burger';
const DRINK = 'product-drink';

const NOW = new Date('2026-09-06T12:00:00.000Z');

function promotion(overrides: Partial<PromotionInput> = {}): PromotionInput {
  return {
    id: 'promo-1',
    name: 'Ten off',
    discountType: DiscountType.PERCENTAGE,
    discountValue: new Prisma.Decimal(10),
    maxDiscountMinor: null,
    branchIds: [],
    startsAt: new Date('2026-09-01T00:00:00.000Z'),
    endsAt: new Date('2026-09-30T00:00:00.000Z'),
    isActive: true,
    priority: 0,
    productIds: [],
    ...overrides,
  };
}

/** A cart of one 60.00 burger and one 20.00 drink. */
function context(overrides: Partial<PromotionContext> = {}): PromotionContext {
  return {
    branchId: BRANCH,
    lines: [
      { productId: BURGER, grossMinor: 6000 },
      { productId: DRINK, grossMinor: 2000 },
    ],
    subtotalMinor: 8000,
    deliveryFeeMinor: 500,
    now: NOW,
    ...overrides,
  };
}

describe('evaluatePromotion', () => {
  it('takes a percentage off the whole basket when no products are listed', () => {
    const applied = evaluatePromotion(promotion(), context());

    expect(applied).not.toBeNull();
    expect(applied?.discountMinor).toBe(800);
    expect(applied?.qualifyingSubtotalMinor).toBe(8000);
    expect(applied?.discount.appliesToDeliveryFee).toBe(false);
  });

  /**
   * The expensive mistake this rules out. "20% off burgers" that quietly takes
   * 20% off the drinks too gives away money on every basket that mixes them,
   * and nothing on any screen would say so — the total is simply lower than the
   * owner intended.
   */
  it('measures a product promotion on the qualifying lines only', () => {
    const applied = evaluatePromotion(
      promotion({ discountValue: new Prisma.Decimal(20), productIds: [BURGER] }),
      context(),
    );

    expect(applied?.qualifyingSubtotalMinor).toBe(6000);
    expect(applied?.discountMinor).toBe(1200);
  });

  it('does not apply when none of its products are in the cart', () => {
    expect(
      evaluatePromotion(promotion({ productIds: ['product-not-in-cart'] }), context()),
    ).toBeNull();
  });

  it('caps a percentage at maxDiscountMinor', () => {
    const applied = evaluatePromotion(
      promotion({ discountValue: new Prisma.Decimal(50), maxDiscountMinor: 1000 }),
      context(),
    );

    expect(applied?.discountMinor).toBe(1000);
  });

  /** A fixed promotion larger than the basket is a discount, never a credit. */
  it('never discounts more than the part of the basket it applies to', () => {
    const applied = evaluatePromotion(
      promotion({
        discountType: DiscountType.FIXED_AMOUNT,
        discountValue: new Prisma.Decimal(9999),
        productIds: [DRINK],
      }),
      context(),
    );

    expect(applied?.discountMinor).toBe(2000);
  });

  it('sends a free-delivery promotion at the delivery fee, not the items', () => {
    const applied = evaluatePromotion(
      promotion({ discountType: DiscountType.FREE_DELIVERY }),
      context(),
    );

    expect(applied?.discountMinor).toBe(500);
    expect(applied?.discount.appliesToDeliveryFee).toBe(true);
  });

  it('is worth nothing on a pickup order when it only frees delivery', () => {
    expect(
      evaluatePromotion(
        promotion({ discountType: DiscountType.FREE_DELIVERY }),
        context({ deliveryFeeMinor: 0 }),
      ),
    ).toBeNull();
  });

  it('does not apply when inactive, outside its window, or at another branch', () => {
    expect(evaluatePromotion(promotion({ isActive: false }), context())).toBeNull();
    expect(
      evaluatePromotion(promotion({ startsAt: new Date('2026-09-07T00:00:00.000Z') }), context()),
    ).toBeNull();
    expect(
      evaluatePromotion(promotion({ endsAt: new Date('2026-09-05T00:00:00.000Z') }), context()),
    ).toBeNull();
    expect(evaluatePromotion(promotion({ branchIds: ['branch-2'] }), context())).toBeNull();
  });

  /**
   * `endsAt` is exclusive, matching `listActive`'s `endsAt: { gt: now }`. If the
   * two disagreed, a promotion would be advertised on the Offers tab for a
   * moment after the checkout had stopped honouring it.
   */
  it('treats endsAt as exclusive, the same way listActive queries it', () => {
    expect(evaluatePromotion(promotion({ endsAt: NOW }), context())).toBeNull();
    expect(
      evaluatePromotion(promotion({ endsAt: new Date(NOW.getTime() + 1) }), context()),
    ).not.toBeNull();
  });

  it('applies at every branch when branchIds is empty', () => {
    expect(evaluatePromotion(promotion(), context({ branchId: 'branch-99' }))).not.toBeNull();
  });
});

describe('selectBestPromotion', () => {
  it('returns null when nothing qualifies', () => {
    expect(selectBestPromotion([promotion({ isActive: false })], context())).toBeNull();
  });

  /**
   * Only one promotion applies. Two automatic discounts compounding is how a
   * basket ends up at a price nobody published, and it is invisible until the
   * settlement report.
   */
  it('applies exactly one promotion — the one worth most', () => {
    const applied = selectBestPromotion(
      [
        promotion({ id: 'a', name: 'Small', discountValue: new Prisma.Decimal(5) }),
        promotion({ id: 'b', name: 'Big', discountValue: new Prisma.Decimal(25) }),
      ],
      context(),
    );

    expect(applied?.promotionId).toBe('b');
    expect(applied?.discountMinor).toBe(2000);
  });

  it('breaks a tie on the owner’s priority, lowest first', () => {
    const applied = selectBestPromotion(
      [
        promotion({ id: 'a', name: 'Second', priority: 5 }),
        promotion({ id: 'b', name: 'First', priority: 1 }),
      ],
      context(),
    );

    expect(applied?.promotionId).toBe('b');
  });

  /**
   * Two identical promotions must not pick a different winner per request —
   * a total that changes between the quote and the placement is the failure
   * every part of this pricing path is built to avoid.
   */
  it('is deterministic when discount and priority both tie', () => {
    const promotions = [promotion({ id: 'b' }), promotion({ id: 'a' })];

    expect(selectBestPromotion(promotions, context())?.promotionId).toBe('a');
    expect(selectBestPromotion([...promotions].reverse(), context())?.promotionId).toBe('a');
  });

  it('identifies the discount by promotion id, which editing the name cannot change', () => {
    const applied = selectBestPromotion([promotion({ id: 'promo-42' })], context());

    expect(applied?.discount.source).toBe('promotion:promo-42');
  });
});
