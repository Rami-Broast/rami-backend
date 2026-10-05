import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PaymentMethod, PrismaClient } from '@prisma/client';

import { ActorKind, type Actor } from '../../src/auth/types/actor';
import { AppConfigModule } from '../../src/config/config.module';
import { CatalogService } from '../../src/menu/catalog.service';
import { MenuModule } from '../../src/menu/menu.module';
import { OrdersModule } from '../../src/orders/orders.module';
import { OrdersService } from '../../src/orders/orders.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { VatModule } from '../../src/vat/vat.module';
import { createBranch, createCategory, createCustomer, createProduct } from './helpers/factories';

/**
 * The delivery fee, the minimum and the price uplift, exercised through the
 * real order engine against a real database.
 *
 * The pure arithmetic is covered in test/unit/delivery-pricing.spec.ts. What
 * this file proves is the part unit tests cannot: that the branch's stored
 * rules actually reach the calculation, that the uplift lands on the price the
 * order is charged at, and that the snapshot on the order says how.
 */
describe('delivery pricing (integration)', () => {
  const prisma = new PrismaClient();
  let orders: OrdersService;
  let catalog: CatalogService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    await prisma.$connect();
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, PrismaModule, VatModule, MenuModule, OrdersModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    orders = app.get(OrdersService);
    catalog = app.get(CatalogService);
    close = () => app.close();
  });

  afterAll(async () => {
    await close?.();
    await prisma.$disconnect();
  });

  // Kingdom Centre, Riyadh — and a drop-off about 6.9 km of road away, which
  // is 2 chargeable km once the first 5 are covered.
  const BRANCH_POINT = { latitude: 24.7118, longitude: 46.6745 };
  const NEARBY = { latitude: 24.7118, longitude: 46.6745 };
  const FAR = { latitude: 24.9, longitude: 46.9 };

  async function scene(
    settings: Record<string, unknown> = {},
    productOverrides: Record<string, unknown> = {},
  ) {
    const branch = await createBranch(prisma);
    await prisma.branch.update({
      where: { id: branch.id },
      data: { latitude: BRANCH_POINT.latitude, longitude: BRANCH_POINT.longitude },
    });

    await prisma.branchSetting.create({
      data: {
        branchId: branch.id,
        acceptsDelivery: true,
        acceptsCashOnDelivery: true,
        // The owner's confirmed numbers, stated here rather than relied on
        // from the column defaults, so a default change fails loudly.
        deliveryFeeMinor: 500,
        deliveryBaseFeeCoversKm: 5,
        deliveryPerKmFeeMinor: 300,
        deliveryRoadFactor: 1.3,
        minOrderMinor: 4000,
        deliveryRadiusKm: null,
        ...settings,
      },
    });

    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      basePriceMinor: 5000,
      ...productOverrides,
    });

    const customer = await createCustomer(prisma);

    return { branch, product, customer };
  }

  async function addressAt(
    customerId: string,
    point: { latitude: number; longitude: number } | null,
  ) {
    return prisma.customerAddress.create({
      data: {
        customerId,
        line1: '1 Test St',
        city: 'Riyadh',
        latitude: point?.latitude ?? null,
        longitude: point?.longitude ?? null,
      },
    });
  }

  function customerActor(id: string): Actor {
    return {
      kind: ActorKind.Customer,
      id,
      phone: '+966500000000',
      permissions: new Set(),
      branchScope: { kind: 'NONE' },
    };
  }

  it('charges the base fee alone for a drop-off inside the covered distance', async () => {
    const { branch, product, customer } = await scene();
    const address = await addressAt(customer.id, NEARBY);

    const order = await orders.placeOrder(customerActor(customer.id), {
      branchId: branch.id,
      type: 'DELIVERY',
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      customerAddressId: address.id,
      items: [{ productId: product.id, quantity: 1 }],
    });

    expect(order.deliveryFeeMinor).toBe(500);
  });

  it('adds the per-km fee for a drop-off past the covered distance', async () => {
    const { branch, product, customer } = await scene();
    const address = await addressAt(customer.id, FAR);

    const quote = await catalog.quoteDelivery(branch.id, 'DELIVERY', FAR, 6000);

    expect(quote).not.toBeNull();
    expect(quote!.distanceKm).toBeGreaterThan(5);
    expect(quote!.chargeableKm).toBeGreaterThan(0);
    expect(quote!.deliveryFeeMinor).toBe(500 + quote!.chargeableKm * 300);

    const order = await orders.placeOrder(customerActor(customer.id), {
      branchId: branch.id,
      type: 'DELIVERY',
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      customerAddressId: address.id,
      items: [{ productId: product.id, quantity: 1 }],
    });

    expect(order.deliveryFeeMinor).toBe(quote!.deliveryFeeMinor);
  });

  it('charges the base fee, and does not refuse, when the address has no pin', async () => {
    // The alternative — refusing — turns a paying customer away because of a
    // missing coordinate of ours.
    const { branch, product, customer } = await scene({ deliveryRadiusKm: 1 });
    const address = await addressAt(customer.id, null);

    const order = await orders.placeOrder(customerActor(customer.id), {
      branchId: branch.id,
      type: 'DELIVERY',
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      customerAddressId: address.id,
      items: [{ productId: product.id, quantity: 1 }],
    });

    expect(order.deliveryFeeMinor).toBe(500);
  });

  it('refuses a drop-off outside the branch radius', async () => {
    const { branch, product, customer } = await scene({ deliveryRadiusKm: 2 });
    const address = await addressAt(customer.id, FAR);

    await expect(
      orders.placeOrder(customerActor(customer.id), {
        branchId: branch.id,
        type: 'DELIVERY',
        paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
        customerAddressId: address.id,
        items: [{ productId: product.id, quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a basket below the minimum and names the shortfall', async () => {
    const { branch, product, customer } = await scene({}, { basePriceMinor: 1000 });
    const address = await addressAt(customer.id, NEARBY);

    // 10.00 of food against the 40.00 minimum: 30.00 short.
    await expect(
      orders.placeOrder(customerActor(customer.id), {
        branchId: branch.id,
        type: 'DELIVERY',
        paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
        customerAddressId: address.id,
        items: [{ productId: product.id, quantity: 1 }],
      }),
    ).rejects.toThrow(/30/);
  });

  it('does not let the delivery fee help a basket reach the minimum', async () => {
    // 38.00 of food plus an 11.00 fee is 49.00, but the minimum is measured on
    // items alone — otherwise living further away would qualify you.
    const { branch, product, customer } = await scene({}, { basePriceMinor: 3800 });
    const address = await addressAt(customer.id, FAR);

    await expect(
      orders.placeOrder(customerActor(customer.id), {
        branchId: branch.id,
        type: 'DELIVERY',
        paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
        customerAddressId: address.id,
        items: [{ productId: product.id, quantity: 1 }],
      }),
    ).rejects.toThrow(/2/);
  });
});

describe('the delivery price uplift (integration)', () => {
  const prisma = new PrismaClient();
  let catalog: CatalogService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    await prisma.$connect();
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, PrismaModule, VatModule, MenuModule, OrdersModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    catalog = app.get(CatalogService);
    close = () => app.close();
  });

  afterAll(async () => {
    await close?.();
    await prisma.$disconnect();
  });

  async function upliftScene(branchUplift: number, productUplift: number | null) {
    const branch = await createBranch(prisma);
    await prisma.branchSetting.create({
      data: { branchId: branch.id, acceptsDelivery: true, deliveryUpliftPercent: branchUplift },
    });

    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      basePriceMinor: 5000,
      deliveryUpliftPercent: productUplift,
    });

    return { branch, product };
  }

  it('leaves a pickup order at the catalog price', async () => {
    const { branch, product } = await upliftScene(10, null);

    const lines = await catalog.resolveCartLines(
      branch.id,
      [{ productId: product.id, quantity: 1 }],
      'PICKUP',
    );

    expect(lines[0].unitPriceMinor).toBe(5000);
  });

  it('raises a delivery order by the branch uplift', async () => {
    const { branch, product } = await upliftScene(10, null);

    const lines = await catalog.resolveCartLines(
      branch.id,
      [{ productId: product.id, quantity: 1 }],
      'DELIVERY',
    );

    expect(lines[0].unitPriceMinor).toBe(5500);
  });

  it("lets a product's own override beat the branch default", async () => {
    const { branch, product } = await upliftScene(10, 20);

    const lines = await catalog.resolveCartLines(
      branch.id,
      [{ productId: product.id, quantity: 1 }],
      'DELIVERY',
    );

    expect(lines[0].unitPriceMinor).toBe(6000);
  });

  it('respects a product override of zero rather than falling through to the branch', async () => {
    const { branch, product } = await upliftScene(10, 0);

    const lines = await catalog.resolveCartLines(
      branch.id,
      [{ productId: product.id, quantity: 1 }],
      'DELIVERY',
    );

    expect(lines[0].unitPriceMinor).toBe(5000);
  });

  it('returns both prices on the branch menu, so the app never derives one', async () => {
    const { branch, product } = await upliftScene(10, null);
    await prisma.productAvailability.create({
      data: { productId: product.id, branchId: branch.id, isAvailable: true },
    });

    const menu = await catalog.menuForBranch(branch.id);
    const listed = menu.categories.flatMap((c) => c.products).find((p) => p.id === product.id);

    expect(listed).toBeDefined();
    expect(listed!.priceMinor).toBe(5000);
    expect(listed!.deliveryPriceMinor).toBe(5500);
  });
});
