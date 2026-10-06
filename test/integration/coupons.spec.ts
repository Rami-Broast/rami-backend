import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DiscountType, PaymentMethod, PrismaClient } from '@prisma/client';

import { ActorKind, type Actor } from '../../src/auth/types/actor';
import { AppConfigModule } from '../../src/config/config.module';
import { CouponsService } from '../../src/coupons/coupons.service';
import { MenuModule } from '../../src/menu/menu.module';
import { OrdersModule } from '../../src/orders/orders.module';
import { OrdersService } from '../../src/orders/orders.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { VatModule } from '../../src/vat/vat.module';
import {
  createBranch,
  createCategory,
  createCustomer,
  createProduct,
  unique,
} from './helpers/factories';

/**
 * Coupons (Phase 17) against a real database. Proves that a coupon reduces the
 * order total through the VAT engine, that usage is recorded, and that reuse is
 * prevented — the discount never being decided anywhere but server-side.
 */
describe('Coupons (integration)', () => {
  const prisma = new PrismaClient();
  let orders: OrdersService;
  let coupons: CouponsService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    await prisma.$connect();
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, PrismaModule, VatModule, MenuModule, OrdersModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    orders = app.get(OrdersService);
    coupons = app.get(CouponsService);
    close = () => app.close();
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
    const product = await createProduct(prisma, category.id, { basePriceMinor: 10_000 });
    await prisma.productAvailability.create({
      data: { productId: product.id, branchId: branch.id, isAvailable: true },
    });
    const customer = await createCustomer(prisma);
    return { branch, product, customer };
  }

  async function makeCoupon(overrides: Partial<Parameters<CouponsService['create']>[0]> = {}) {
    return coupons.create({
      code: unique('SAVE').toUpperCase(),
      name: 'Test coupon',
      discountType: DiscountType.PERCENTAGE,
      discountValue: '10',
      validFrom: '2020-01-01T00:00:00.000Z',
      validUntil: '2999-01-01T00:00:00.000Z',
      ...overrides,
    });
  }

  function place(branchId: string, productId: string, customerId: string, couponCode?: string) {
    return orders.placeOrder(customerActor(customerId), {
      branchId,
      type: 'PICKUP',
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      items: [{ productId, quantity: 1 }],
      couponCode,
    });
  }

  it('applies a percentage coupon and records its usage', async () => {
    const { branch, product, customer } = await scene();
    const coupon = await makeCoupon();

    const order = await place(branch.id, product.id, customer.id, coupon.code);

    // 10,000 inclusive item, 10% off = 9,000 total.
    expect(order.subtotalMinor).toBe(10_000);
    expect(order.discountMinor).toBe(1000);
    expect(order.totalMinor).toBe(9000);
    expect(order.taxableBaseMinor + order.vatMinor).toBe(order.totalMinor);

    const usage = await prisma.couponUsage.findFirst({ where: { orderId: order.id } });
    expect(usage?.discountAppliedMinor).toBe(1000);
    const reloaded = await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } });
    expect(reloaded.usageCount).toBe(1);
  });

  describe('the Offers page listing', () => {
    /**
     * What the customer app shows. Every case here is a way a customer ends up
     * looking at a code the checkout then refuses — or, in the first one, a way
     * a private code reaches everybody.
     */
    it('lists only what the owner published, and the code it lists is the real one', async () => {
      const published = await makeCoupon({
        name: 'Twenty off',
        isPublic: true,
        imageUrl: 'https://cdn.example.test/offers/twenty.jpg',
        rules: [{ ruleType: 'MIN_SPEND', config: { minSpendMinor: 5000 } }],
      });
      const privateCoupon = await makeCoupon({ name: 'Apology for a late order' });

      const offers = await coupons.listPublic();
      const codes = offers.map((o) => o.code);

      expect(codes).toContain(published.code);
      expect(codes).not.toContain(privateCoupon.code);

      const offer = offers.find((o) => o.code === published.code);
      expect(offer?.imageUrl).toBe('https://cdn.example.test/offers/twenty.jpg');
      // Surfaced so the card can state the condition rather than let the
      // customer discover it at checkout.
      expect(offer?.minSpendMinor).toBe(5000);
    });

    it('hides an expired, not-yet-started, deactivated or exhausted offer', async () => {
      const expired = await makeCoupon({
        isPublic: true,
        validFrom: '2020-01-01T00:00:00.000Z',
        validUntil: '2020-02-01T00:00:00.000Z',
      });
      const future = await makeCoupon({
        isPublic: true,
        validFrom: '2999-01-01T00:00:00.000Z',
        validUntil: '2999-02-01T00:00:00.000Z',
      });
      const exhausted = await makeCoupon({ isPublic: true, totalUsageLimit: 1 });
      await prisma.coupon.update({
        where: { id: exhausted.id },
        data: { usageCount: 1 },
      });
      const switchedOff = await makeCoupon({ isPublic: true });
      await coupons.update(switchedOff.id, { isActive: false });

      const codes = (await coupons.listPublic()).map((o) => o.code);

      for (const hidden of [expired, future, exhausted, switchedOff]) {
        expect(codes).not.toContain(hidden.code);
      }
    });

    it('publishes and unpublishes without touching the terms', async () => {
      const coupon = await makeCoupon({ discountValue: '15' });

      const published = await coupons.update(coupon.id, {
        isPublic: true,
        imageUrl: 'https://cdn.example.test/offers/fifteen.jpg',
      });

      expect(published.isPublic).toBe(true);
      // The fields the owner did not send are untouched — a partial update that
      // quietly clears a neighbour is the failure this asserts against.
      expect(published.code).toBe(coupon.code);
      expect(Number(published.discountValue)).toBe(15);
      expect(published.validUntil).toEqual(coupon.validUntil);

      const unpublished = await coupons.update(coupon.id, { isPublic: false });
      expect(unpublished.isPublic).toBe(false);
      expect(unpublished.imageUrl).toBe('https://cdn.example.test/offers/fifteen.jpg');
      expect((await coupons.listPublic()).map((o) => o.code)).not.toContain(coupon.code);
    });

    it('applies the discount the offer advertises when its code is used', async () => {
      // The whole point of an offer being a coupon: the card the customer taps
      // carries the code the pricing engine already honours, so there is no
      // second discount path that can drift from it.
      const { branch, product, customer } = await scene();
      const coupon = await makeCoupon({ isPublic: true, discountValue: '25' });

      const offer = (await coupons.listPublic()).find((o) => o.code === coupon.code);
      expect(offer).toBeDefined();

      const order = await place(branch.id, product.id, customer.id, offer!.code);
      expect(order.discountMinor).toBe(2500);
      expect(order.totalMinor).toBe(7500);
    });
  });

  it('rejects an unknown code', async () => {
    const { branch, product, customer } = await scene();
    await expect(place(branch.id, product.id, customer.id, 'NOPE-XYZ')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('enforces a total usage limit across customers', async () => {
    const { branch, product, customer } = await scene();
    const other = await createCustomer(prisma);
    const coupon = await makeCoupon({ totalUsageLimit: 1 });

    await place(branch.id, product.id, customer.id, coupon.code);
    // Second customer, same coupon — the single use is gone.
    await expect(place(branch.id, product.id, other.id, coupon.code)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('enforces a per-customer limit', async () => {
    const { branch, product, customer } = await scene();
    const coupon = await makeCoupon({ perCustomerLimit: 1 });

    await place(branch.id, product.id, customer.id, coupon.code);
    await expect(place(branch.id, product.id, customer.id, coupon.code)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('enforces a first-order rule', async () => {
    const { branch, product, customer } = await scene();
    const coupon = await makeCoupon({
      rules: [{ ruleType: 'FIRST_ORDER', config: {} }],
    });

    // First order qualifies.
    await place(branch.id, product.id, customer.id, coupon.code);
    // The customer now has an order, so a second use of a first-order coupon fails.
    await expect(place(branch.id, product.id, customer.id, coupon.code)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('does not let a client fabricate a discount without a coupon', async () => {
    const { branch, product, customer } = await scene();
    const order = await place(branch.id, product.id, customer.id);
    expect(order.discountMinor).toBe(0);
    expect(order.totalMinor).toBe(10_000);
  });

  // --- Coupon-aware quote preview (read-only) --------------------------------

  function quote(branchId: string, productId: string, customerId: string, couponCode?: string) {
    return orders.quoteForCustomer(customerActor(customerId), {
      branchId,
      type: 'PICKUP',
      items: [{ productId, quantity: 1 }],
      couponCode,
    });
  }

  it('previews a valid coupon without recording usage', async () => {
    const { branch, product, customer } = await scene();
    const coupon = await makeCoupon();

    const result = await quote(branch.id, product.id, customer.id, coupon.code);
    expect(result.quote.discountMinor).toBe(1000);
    expect(result.quote.totalMinor).toBe(9000);
    expect(result.coupon?.discountMinor).toBe(1000);
    // The offer's own name travels with the quote: a bill that can only quote
    // a code back ("SAVE20 applied") makes the customer remember which deal
    // that was, on the screen where they are checking the money.
    expect(result.coupon?.name).toBe('Test coupon');
    expect(result.couponError).toBeNull();

    // Read-only: the coupon was not consumed by the preview.
    const reloaded = await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } });
    expect(reloaded.usageCount).toBe(0);
    expect(await prisma.couponUsage.count({ where: { couponId: coupon.id } })).toBe(0);
  });

  it('returns the base price plus a couponError for an invalid code', async () => {
    const { branch, product, customer } = await scene();
    const result = await quote(branch.id, product.id, customer.id, 'NOPE-XYZ');
    expect(result.quote.totalMinor).toBe(10_000);
    expect(result.quote.discountMinor).toBe(0);
    expect(result.coupon).toBeNull();
    expect(result.couponError).toBeTruthy();
  });

  it('quotes the base price when no coupon is supplied', async () => {
    const { branch, product, customer } = await scene();
    const result = await quote(branch.id, product.id, customer.id);
    expect(result.quote.totalMinor).toBe(10_000);
    expect(result.coupon).toBeNull();
    expect(result.couponError).toBeNull();
  });
});
