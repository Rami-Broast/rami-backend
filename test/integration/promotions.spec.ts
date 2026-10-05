import { Test } from '@nestjs/testing';
import { DiscountType, PaymentMethod, PrismaClient } from '@prisma/client';

import { ActorKind, type Actor } from '../../src/auth/types/actor';
import { AppConfigModule } from '../../src/config/config.module';
import { CouponsService } from '../../src/coupons/coupons.service';
import { CatalogController } from '../../src/menu/catalog.controller';
import { MenuModule } from '../../src/menu/menu.module';
import { OrdersModule } from '../../src/orders/orders.module';
import { OrdersService } from '../../src/orders/orders.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PromotionsModule } from '../../src/promotions/promotions.module';
import { PromotionsService } from '../../src/promotions/promotions.service';
import { CouponsModule } from '../../src/coupons/coupons.module';
import { VatModule } from '../../src/vat/vat.module';
import {
  createBranch,
  createCategory,
  createCustomer,
  createProduct,
  unique,
} from './helpers/factories';

/**
 * Automatic promotions against a real database.
 *
 * The point of this file is the thing that was missing: a promotion could be
 * created, published and served to the customer app, and **nothing applied it to
 * a price**. Every assertion here is on the amount the order was actually
 * charged, read back off the row — not on what the service returned.
 */
describe('Promotions (integration)', () => {
  const prisma = new PrismaClient();
  let orders: OrdersService;
  let promotions: PromotionsService;
  let coupons: CouponsService;
  let catalogController: CatalogController;
  let close: () => Promise<void>;

  beforeAll(async () => {
    await prisma.$connect();
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        PrismaModule,
        VatModule,
        MenuModule,
        OrdersModule,
        PromotionsModule,
        CouponsModule,
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    orders = app.get(OrdersService);
    promotions = app.get(PromotionsService);
    coupons = app.get(CouponsService);
    catalogController = app.get(CatalogController);
    close = () => app.close();

    // Retire any org-wide promotion left in the shared test database.
    //
    // A promotion with no `branchIds` applies to every branch, so one left
    // behind — by a crashed run of this suite, or by a future test that forgets
    // to scope one — silently discounts orders in *every* other integration and
    // e2e suite. The symptom is a total that is wrong by some percentage in a
    // file that has nothing to do with promotions, which is a genuinely hard
    // thing to trace back to here.
    await prisma.promotion.updateMany({
      where: { branchIds: { isEmpty: true }, deletedAt: null },
      data: { isActive: false, deletedAt: new Date() },
    });
  });

  afterAll(async () => {
    await close?.();
    await prisma.$disconnect();
  });

  function customerActor(id: string): Actor {
    return {
      kind: ActorKind.Customer,
      id,
      phone: '+966500000000',
      permissions: new Set(),
      branchScope: { kind: 'NONE' },
    };
  }

  /** One branch, two 100.00 products, one customer. */
  async function scene() {
    const branch = await createBranch(prisma);
    await prisma.branchSetting.create({
      data: {
        branchId: branch.id,
        acceptsCashOnDelivery: true,
        deliveryFeeMinor: 0,
        minOrderMinor: 0,
      },
    });
    const category = await createCategory(prisma);
    const promoted = await createProduct(prisma, category.id, { basePriceMinor: 10_000 });
    const other = await createProduct(prisma, category.id, { basePriceMinor: 10_000 });
    for (const product of [promoted, other]) {
      await prisma.productAvailability.create({
        data: { productId: product.id, branchId: branch.id, isAvailable: true },
      });
    }
    const customer = await createCustomer(prisma);
    return { branch, promoted, other, customer };
  }

  /**
   * Every promotion here is scoped to its own scene's branch.
   *
   * Not tidiness — the suite shares one database, and a promotion with no
   * `branchIds` applies to *every* branch, so an org-wide one created by one
   * test discounts the orders of every test after it (and of every other suite
   * that places an order). Scoping is also what the branch-isolation case below
   * asserts, so the two needs coincide.
   */
  function makePromotion(
    branchId: string,
    overrides: Partial<Parameters<PromotionsService['create']>[0]> = {},
  ) {
    return promotions.create({
      name: 'Ten off everything',
      discountType: DiscountType.PERCENTAGE,
      discountValue: 10,
      branchIds: [branchId],
      startsAt: '2020-01-01T00:00:00.000Z',
      endsAt: '2999-01-01T00:00:00.000Z',
      ...overrides,
    });
  }

  function place(branchId: string, productIds: string[], customerId: string, couponCode?: string) {
    return orders.placeOrder(customerActor(customerId), {
      branchId,
      type: 'PICKUP',
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      items: productIds.map((productId) => ({ productId, quantity: 1 })),
      couponCode,
    });
  }

  it('does not discount anything while the promotion is unpublished', async () => {
    const { branch, promoted, customer } = await scene();
    await makePromotion(branch.id);

    const order = await place(branch.id, [promoted.id], customer.id);

    // `isActive` defaults to false: creating a promotion must not start giving
    // money away before the owner presses Publish.
    expect(order.discountMinor).toBe(0);
    expect(order.totalMinor).toBe(10_000);
    expect(order.promotionId).toBeNull();
  });

  it('applies a published promotion with no code typed, and records which one', async () => {
    const { branch, promoted, customer } = await scene();
    const promotion = await makePromotion(branch.id);
    await promotions.publish(promotion.id);

    const order = await place(branch.id, [promoted.id], customer.id);

    expect(order.subtotalMinor).toBe(10_000);
    expect(order.discountMinor).toBe(1000);
    expect(order.totalMinor).toBe(9000);
    // The invariant every priced order holds, re-checked on a discounted one.
    expect(order.taxableBaseMinor + order.vatMinor).toBe(order.totalMinor);
    expect(order.promotionId).toBe(promotion.id);
  });

  /**
   * The expensive mistake. "10% off this dish" that takes 10% off the whole
   * basket gives money away on every mixed order, and no screen would say so.
   */
  it('measures a product promotion on its own products only', async () => {
    const { branch, promoted, other, customer } = await scene();
    const promotion = await makePromotion(branch.id, { productIds: [promoted.id] });
    await promotions.publish(promotion.id);

    const order = await place(branch.id, [promoted.id, other.id], customer.id);

    expect(order.subtotalMinor).toBe(20_000);
    expect(order.discountMinor).toBe(1000);
    expect(order.totalMinor).toBe(19_000);
  });

  it('quotes the same discount the placement charges', async () => {
    const { branch, promoted, customer } = await scene();
    const promotion = await makePromotion(branch.id, { discountValue: 20 });
    await promotions.publish(promotion.id);

    const quoted = await orders.quoteForCustomer(customerActor(customer.id), {
      branchId: branch.id,
      type: 'PICKUP',
      items: [{ productId: promoted.id, quantity: 1 }],
    });

    expect(quoted.promotion?.promotionId).toBe(promotion.id);
    expect(quoted.promotion?.name).toBe('Ten off everything');
    expect(quoted.quote.totalMinor).toBe(8000);

    const order = await place(branch.id, [promoted.id], customer.id);
    // A total that moves between the screen and the charge is the failure this
    // whole pricing path is arranged to prevent.
    expect(order.totalMinor).toBe(quoted.quote.totalMinor);
  });

  it('shows on the POS running total, which is priced through /pricing/quote', async () => {
    const { branch, promoted, customer } = await scene();
    const promotion = await makePromotion(branch.id);
    await promotions.publish(promotion.id);

    // The Branch POS prices its cart on `POST /pricing/quote` and then places
    // through `placeOrderForStaff`. If only one of the two knew about
    // promotions, the counter would read a price out to the customer and the
    // till would take a different one, with nobody at the branch able to say
    // why.
    const quoted = await catalogController.quote({
      branchId: branch.id,
      type: 'PICKUP',
      items: [{ productId: promoted.id, quantity: 1 }],
    });

    expect(quoted.totalMinor).toBe(9000);

    const order = await place(branch.id, [promoted.id], customer.id);
    expect(order.totalMinor).toBe(quoted.totalMinor);
  });

  describe('a promotion and a coupon stack', () => {
    async function makeCoupon(discountValue: string) {
      return coupons.create({
        code: unique('SAVE').toUpperCase(),
        name: 'A typed code',
        discountType: DiscountType.PERCENTAGE,
        discountValue,
        validFrom: '2020-01-01T00:00:00.000Z',
        validUntil: '2999-01-01T00:00:00.000Z',
      });
    }

    /**
     * Owner decision, 2026-09-10. Until then the engine charged whichever was
     * worth more and told the customer their code had been superseded; a
     * customer who both qualified for a standing offer and held a code now
     * gets both.
     */
    it('applies both, and records which one gave what', async () => {
      const { branch, promoted, customer } = await scene();
      const promotion = await makePromotion(branch.id, { discountValue: 10 });
      await promotions.publish(promotion.id);
      const coupon = await makeCoupon('30');

      const order = await place(branch.id, [promoted.id], customer.id, coupon.code);

      // 10% + 30% off a 100.00 line, both measured on the undiscounted gross:
      // nothing compounds, so this is 40.00 and not 37.00.
      expect(order.discountMinor).toBe(4000);
      expect(order.couponId).toBe(coupon.id);
      expect(order.promotionId).toBe(promotion.id);

      const recorded = await prisma.orderDiscount.findMany({
        where: { orderId: order.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(recorded.map((d) => [d.kind, d.amountMinor])).toEqual([
        ['PROMOTION', 1000],
        ['COUPON', 3000],
      ]);
      // The rows are the aggregate, itemised — never a different number.
      expect(recorded.reduce((sum, d) => sum + d.amountMinor, 0)).toBe(order.discountMinor);
    });

    it('spends the customer’s code, because it now buys them something', async () => {
      const { branch, promoted, customer } = await scene();
      const promotion = await makePromotion(branch.id, { discountValue: 40 });
      await promotions.publish(promotion.id);
      const coupon = await makeCoupon('5');

      const order = await place(branch.id, [promoted.id], customer.id, coupon.code);

      expect(order.discountMinor).toBe(4500);
      expect(order.promotionId).toBe(promotion.id);
      expect(order.couponId).toBe(coupon.id);

      const reloaded = await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } });
      expect(reloaded.usageCount).toBe(1);
      expect(await prisma.couponUsage.count({ where: { couponId: coupon.id } })).toBe(1);
    });

    it('never takes an order below zero, however generous the pair is', async () => {
      const { branch, promoted, customer } = await scene();
      const promotion = await makePromotion(branch.id, { discountValue: 70 });
      await promotions.publish(promotion.id);
      const coupon = await makeCoupon('70');

      const order = await place(branch.id, [promoted.id], customer.id, coupon.code);

      // 140% of the basket was asked for; the engine clamps at the basket.
      expect(order.discountMinor).toBe(10000);
      expect(order.totalMinor).toBe(0);

      // And what is recorded is what was *given*, shared out in proportion to
      // what each asked for — booking the request would put a 140.00 giveaway
      // on the books that never happened.
      const recorded = await prisma.orderDiscount.findMany({ where: { orderId: order.id } });
      expect(recorded.reduce((sum, d) => sum + d.amountMinor, 0)).toBe(10000);
    });

    it('reports both on the quote, and supersedes nothing', async () => {
      const { branch, promoted, customer } = await scene();
      const promotion = await makePromotion(branch.id, { discountValue: 40, name: 'Forty off' });
      await promotions.publish(promotion.id);
      const coupon = await makeCoupon('5');

      const quoted = await orders.quoteForCustomer(customerActor(customer.id), {
        branchId: branch.id,
        type: 'PICKUP',
        items: [{ productId: promoted.id, quantity: 1 }],
        couponCode: coupon.code,
      });

      expect(quoted.coupon?.discountMinor).toBe(500);
      expect(quoted.promotion?.name).toBe('Forty off');
      expect(quoted.couponError).toBeNull();
      // Nothing loses any more, so nothing is superseded. The field stays on
      // the response because clients render it.
      expect(quoted.couponSuperseded).toBeNull();
      expect(quoted.quote.discountMinor).toBe(4500);
    });
  });

  it('runs only at the branches the owner chose', async () => {
    const here = await scene();
    const elsewhere = await scene();
    const promotion = await makePromotion(here.branch.id, { discountValue: 50 });
    await promotions.publish(promotion.id);

    const discounted = await place(here.branch.id, [here.promoted.id], here.customer.id);
    expect(discounted.discountMinor).toBe(5000);

    const untouched = await place(
      elsewhere.branch.id,
      [elsewhere.promoted.id],
      elsewhere.customer.id,
    );
    expect(untouched.discountMinor).toBe(0);
    expect(untouched.promotionId).toBeNull();
  });

  it('keeps discounting orders after the promotion is deleted', async () => {
    const { branch, promoted, customer } = await scene();
    const promotion = await makePromotion(branch.id);
    await promotions.publish(promotion.id);
    const order = await place(branch.id, [promoted.id], customer.id);

    await promotions.remove(promotion.id);

    // Soft delete, and the FK is SET NULL on a hard one: what the customer was
    // charged is snapshotted on the order and must survive the offer ending.
    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.totalMinor).toBe(9000);
    expect(reloaded.discountMinor).toBe(1000);

    // And a new order gets nothing.
    const after = await place(branch.id, [promoted.id], customer.id);
    expect(after.discountMinor).toBe(0);
  });
});
