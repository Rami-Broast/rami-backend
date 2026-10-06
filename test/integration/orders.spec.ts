import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { OrderStatus, PaymentMethod, PaymentStatus, PrismaClient } from '@prisma/client';

import { ActorKind, type Actor } from '../../src/auth/types/actor';
import { AppConfigModule } from '../../src/config/config.module';
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
 * The order engine (Phase 8) against a real database.
 *
 * These prove the properties that only show up end to end: the price snapshot
 * is written from the VAT engine and nothing the client says, fulfilment and
 * payment advance independently, branch isolation holds on every staff path,
 * and the status machine refuses illegal moves.
 */
describe('OrdersService (integration)', () => {
  const prisma = new PrismaClient();
  let orders: OrdersService;
  let close: () => Promise<void>;
  // A real staff user, so status-history rows that attribute a transition to a
  // user satisfy the foreign key — the app only ever holds resolved user ids.
  let ownerUserId: string;

  beforeAll(async () => {
    await prisma.$connect();

    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, PrismaModule, VatModule, MenuModule, OrdersModule],
    }).compile();

    const app = moduleRef.createNestApplication();
    await app.init();

    orders = app.get(OrdersService);
    close = () => app.close();

    const owner = await prisma.user.create({
      data: { email: `${unique('owner')}@test`, fullName: 'Owner', passwordHash: 'x' },
    });
    ownerUserId = owner.id;
  });

  afterAll(async () => {
    await close?.();
    await prisma.$disconnect();
  });

  // --- Fixtures --------------------------------------------------------------

  interface SceneOptions {
    acceptsCashOnDelivery?: boolean;
    acceptsDelivery?: boolean;
    acceptsPickup?: boolean;
    isAcceptingOrders?: boolean;
    deliveryFeeMinor?: number;
    minOrderMinor?: number;
    basePriceMinor?: number;
  }

  async function scene(options: SceneOptions = {}) {
    const branch = await createBranch(prisma);
    await prisma.branchSetting.create({
      data: {
        branchId: branch.id,
        acceptsDelivery: options.acceptsDelivery ?? true,
        acceptsPickup: options.acceptsPickup ?? true,
        isAcceptingOrders: options.isAcceptingOrders ?? true,
        acceptsCashOnDelivery: options.acceptsCashOnDelivery ?? true,
        deliveryFeeMinor: options.deliveryFeeMinor ?? 0,
        minOrderMinor: options.minOrderMinor ?? 0,
      },
    });

    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      basePriceMinor: options.basePriceMinor ?? 11_500,
    });
    await prisma.productAvailability.create({
      data: { productId: product.id, branchId: branch.id, isAvailable: true },
    });

    const customer = await createCustomer(prisma);
    const address = await prisma.customerAddress.create({
      data: { customerId: customer.id, line1: '1 Test St', city: 'Riyadh' },
    });

    return { branch, product, customer, address };
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

  function ownerActor(): Actor {
    return {
      kind: ActorKind.Staff,
      id: ownerUserId,
      email: 'owner@test',
      fullName: 'Owner',
      roles: ['OWNER'],
      permissions: new Set(['orders:read', 'orders:kitchen', 'orders:cancel']),
      branchScope: { kind: 'ALL' },
    };
  }

  function branchStaffActor(id: string, branchIds: string[]): Actor {
    return {
      kind: ActorKind.Staff,
      id,
      email: `${id}@test`,
      fullName: 'Branch Staff',
      roles: ['BRANCH_ADMIN'],
      permissions: new Set(['orders:read', 'orders:kitchen', 'orders:cancel']),
      branchScope: { kind: 'ASSIGNED', branchIds },
    };
  }

  // --- Opening hours --------------------------------------------------------

  /**
   * The schedule was fully built — timezone-aware, per-day, with holiday
   * overrides — and nothing read it. A customer could order at 03:00 and the
   * branch found the ticket in the morning.
   */
  describe('opening hours', () => {
    /** Every day of the week, closed. The bluntest way to make a branch shut. */
    const alwaysClosed = (branchId: string) =>
      prisma.branchOpeningHours.createMany({
        data: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
          branchId,
          dayOfWeek,
          openMinute: 0,
          closeMinute: 0,
          isClosed: true,
        })),
      });

    /** Every day, all day. Configured *and* open, which is not the same as unconfigured. */
    const alwaysOpen = (branchId: string) =>
      prisma.branchOpeningHours.createMany({
        data: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
          branchId,
          dayOfWeek,
          openMinute: 0,
          closeMinute: 1439,
          isClosed: false,
        })),
      });

    const cart = (branchId: string, productId: string, addressId: string) => ({
      branchId,
      type: 'DELIVERY' as const,
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      customerAddressId: addressId,
      items: [{ productId, quantity: 1 }],
    });

    /**
     * The rule that makes this safe to ship at all. Every branch on the
     * platform predates the hours editor, so an empty schedule read as "closed"
     * would have refused every order the day this landed.
     */
    it('accepts an order from a branch nobody has set hours for', async () => {
      const { branch, product, customer, address } = await scene();

      const order = await orders.placeOrder(
        customerActor(customer.id),
        cart(branch.id, product.id, address.id),
      );

      expect(order.id).toBeTruthy();
    });

    it('refuses a customer order while the branch is closed', async () => {
      const { branch, product, customer, address } = await scene();
      await alwaysClosed(branch.id);

      await expect(
        orders.placeOrder(customerActor(customer.id), cart(branch.id, product.id, address.id)),
      ).rejects.toThrow(/closed/i);
    });

    it('accepts it again once the branch is open', async () => {
      const { branch, product, customer, address } = await scene();
      await alwaysOpen(branch.id);

      const order = await orders.placeOrder(
        customerActor(customer.id),
        cart(branch.id, product.id, address.id),
      );

      expect(order.id).toBeTruthy();
    });

    /**
     * The asymmetry, and it is deliberate. Staff taking a walk-in are standing
     * in the shop: if the schedule says shut and a customer is at the counter,
     * the schedule is what is wrong, and refusing the sale to defend it would
     * be the app arguing with the room.
     */
    it('still lets the counter take a walk-in while the branch is closed', async () => {
      const { branch, product } = await scene({ acceptsCashOnDelivery: true });
      await alwaysClosed(branch.id);

      const order = await orders.placeOrderForStaff(ownerActor(), {
        branchId: branch.id,
        type: 'PICKUP',
        paymentMethod: PaymentMethod.CASH,
        cashCollected: true,
        customerPhone: `+96650${Date.now().toString().slice(-7)}`,
        items: [{ productId: product.id, quantity: 1 }],
      });

      expect(order.id).toBeTruthy();
    });

    /**
     * A closed branch must be visible on the quote, not sprung on the Pay
     * button — the same discipline the delivery blockers already follow. The
     * totals stay on screen while the customer decides what to do about it.
     */
    it('tells the quote the branch is closed, without failing the quote', async () => {
      const { branch, product, customer, address } = await scene();
      await alwaysClosed(branch.id);

      const quote = await orders.quoteForCustomer(customerActor(customer.id), {
        branchId: branch.id,
        type: 'DELIVERY',
        customerAddressId: address.id,
        items: [{ productId: product.id, quantity: 1 }],
      });

      expect(quote.branchOpen.isOpen).toBe(false);
      expect(quote.branchOpen.message).toMatch(/closed/i);
      // The point of not throwing: the customer can still see what they were
      // about to pay.
      expect(quote.quote.totalMinor).toBeGreaterThan(0);
    });

    it('a holiday override closes a branch that is otherwise open, and says why', async () => {
      const { branch, product, customer, address } = await scene();
      await alwaysOpen(branch.id);

      // Today, in the branch's own timezone.
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Riyadh',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());

      await prisma.branchHoursOverride.create({
        data: { branchId: branch.id, date: new Date(today), isClosed: true, note: 'Eid holiday' },
      });

      const quote = await orders.quoteForCustomer(customerActor(customer.id), {
        branchId: branch.id,
        type: 'DELIVERY',
        customerAddressId: address.id,
        items: [{ productId: product.id, quantity: 1 }],
      });

      expect(quote.branchOpen.isOpen).toBe(false);
      // "Closed for Eid" answers the next question; "closed" invites a phone
      // call to a branch with nobody in it.
      expect(quote.branchOpen.message).toContain('Eid holiday');

      await expect(
        orders.placeOrder(customerActor(customer.id), cart(branch.id, product.id, address.id)),
      ).rejects.toThrow(/Eid holiday/);
    });
  });

  // --- Placement and pricing snapshot ---------------------------------------

  it('prices an order from the catalog and snapshots the breakdown', async () => {
    const { branch, product, customer, address } = await scene({ deliveryFeeMinor: 1150 });

    const order = await orders.placeOrder(customerActor(customer.id), {
      branchId: branch.id,
      type: 'DELIVERY',
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      customerAddressId: address.id,
      items: [{ productId: product.id, quantity: 1 }],
    });

    // 11,500 inclusive item + 1,150 inclusive delivery, VAT backed out at 15%.
    expect(order.subtotalMinor).toBe(11_500);
    expect(order.deliveryFeeMinor).toBe(1150);
    expect(order.totalMinor).toBe(12_650);
    expect(order.taxableBaseMinor).toBe(11_000);
    expect(order.vatMinor).toBe(1650);
    expect(order.taxableBaseMinor + order.vatMinor).toBe(order.totalMinor);
    expect(order.vatRate.toString()).toBe('0.15');
    expect(order.priceBreakdown).toBeTruthy();
    expect(order.items).toHaveLength(1);
    expect(order.items[0].productName).toBe(product.name);
    // First order this branch has taken: its own series starts at 1000000.
    expect(order.orderNumber).toBe('1000000');
    // ...and a globally unique 12-digit public reference alongside it.
    expect(order.referenceId).toMatch(/^[1-9][0-9]{11}$/);
  });

  it('keeps the snapshot even after the menu price changes', async () => {
    const { branch, product, customer } = await scene({ basePriceMinor: 11_500 });

    const order = await orders.placeOrder(customerActor(customer.id), {
      branchId: branch.id,
      type: 'PICKUP',
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      items: [{ productId: product.id, quantity: 1 }],
    });

    await prisma.product.update({ where: { id: product.id }, data: { basePriceMinor: 99_999 } });

    const reloaded = await orders.getForCustomer(customerActor(customer.id), order.id);
    expect(reloaded.totalMinor).toBe(11_500);
    expect(reloaded.items[0].unitPriceMinor).toBe(11_500);
  });

  it('ignores any price a client tries to smuggle in the cart', async () => {
    const { branch, product, customer } = await scene();

    const order = await orders.placeOrder(customerActor(customer.id), {
      branchId: branch.id,
      type: 'PICKUP',
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      // A fabricated unit price rides along; the engine never reads it.
      items: [{ productId: product.id, quantity: 1, unitPriceMinor: 1 } as never],
    });

    expect(order.totalMinor).toBe(11_500);
  });

  // --- Fulfilment vs payment separation --------------------------------------

  it('confirms a COD order for the kitchen while payment stays pending', async () => {
    const { branch, product, customer, address } = await scene();

    const order = await orders.placeOrder(customerActor(customer.id), {
      branchId: branch.id,
      type: 'DELIVERY',
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      customerAddressId: address.id,
      items: [{ productId: product.id, quantity: 2 }],
    });

    expect(order.status).toBe(OrderStatus.CONFIRMED);
    expect(order.paymentStatus).toBe(PaymentStatus.PENDING);

    const payment = await prisma.payment.findFirst({ where: { orderId: order.id } });
    expect(payment?.method).toBe(PaymentMethod.CASH_ON_DELIVERY);
    expect(payment?.status).toBe(PaymentStatus.PENDING);
    expect(payment?.amountMinor).toBe(order.totalMinor);

    // Placed → confirmed, both recorded.
    expect(order.statusHistory.map((h) => h.toStatus)).toEqual([
      OrderStatus.PENDING_PAYMENT,
      OrderStatus.CONFIRMED,
    ]);
  });

  it('leaves an online order awaiting payment with no payment row yet', async () => {
    const { branch, product, customer } = await scene();

    const order = await orders.placeOrder(customerActor(customer.id), {
      branchId: branch.id,
      type: 'PICKUP',
      paymentMethod: PaymentMethod.CARD,
      items: [{ productId: product.id, quantity: 1 }],
    });

    expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(order.paymentStatus).toBe(PaymentStatus.PENDING);
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(0);
  });

  // --- Placement guards ------------------------------------------------------

  it('rejects COD where the branch does not offer it', async () => {
    const { branch, product, customer, address } = await scene({ acceptsCashOnDelivery: false });

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

  it('requires a delivery address for a delivery order', async () => {
    const { branch, product, customer } = await scene();

    await expect(
      orders.placeOrder(customerActor(customer.id), {
        branchId: branch.id,
        type: 'DELIVERY',
        paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
        items: [{ productId: product.id, quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses another customer's saved address", async () => {
    const { branch, product, customer } = await scene();
    const intruder = await createCustomer(prisma);
    const theirAddress = await prisma.customerAddress.create({
      data: { customerId: customer.id, line1: '9 Other St', city: 'Riyadh' },
    });

    await expect(
      orders.placeOrder(customerActor(intruder.id), {
        branchId: branch.id,
        type: 'DELIVERY',
        paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
        customerAddressId: theirAddress.id,
        items: [{ productId: product.id, quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('enforces the minimum order on a delivery, and says how much more is needed', async () => {
    const { branch, product, customer, address } = await scene({ minOrderMinor: 50_000 });

    // 115.00 of food against a 500.00 minimum.
    await expect(
      orders.placeOrder(customerActor(customer.id), {
        branchId: branch.id,
        type: 'DELIVERY',
        paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
        customerAddressId: address.id,
        items: [{ productId: product.id, quantity: 1 }],
      }),
    ).rejects.toThrow(/385/);
  });

  it('does not impose the delivery minimum on a pickup order', async () => {
    // `minOrderMinor` is the *delivery* minimum (40 SAR, owner 2026-09-04).
    // It used to apply to every order type, which would refuse a walk-in
    // buying one coffee — and with the minimum now defaulting to 4000 rather
    // than 0, that would have been every small counter sale.
    const { branch, product, customer } = await scene({ minOrderMinor: 50_000 });

    const order = await orders.placeOrder(customerActor(customer.id), {
      branchId: branch.id,
      type: 'PICKUP',
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      items: [{ productId: product.id, quantity: 1 }],
    });

    expect(order.totalMinor).toBe(11_500);
  });

  it('refuses an order when the branch is not accepting orders', async () => {
    const { branch, product, customer } = await scene({ isAcceptingOrders: false });

    await expect(
      orders.placeOrder(customerActor(customer.id), {
        branchId: branch.id,
        type: 'PICKUP',
        paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
        items: [{ productId: product.id, quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a non-customer placing an order', async () => {
    const { branch, product } = await scene();

    await expect(
      orders.placeOrder(ownerActor(), {
        branchId: branch.id,
        type: 'PICKUP',
        paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
        items: [{ productId: product.id, quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // --- Kitchen transitions ---------------------------------------------------

  it('walks an order through the kitchen and refuses illegal jumps', async () => {
    const { branch, product, customer, address } = await scene();
    const staff = ownerActor();

    const placed = await orders.placeOrder(customerActor(customer.id), {
      branchId: branch.id,
      type: 'DELIVERY',
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      customerAddressId: address.id,
      items: [{ productId: product.id, quantity: 1 }],
    });

    // CONFIRMED (COD) → PREPARING → READY.
    const preparing = await orders.markPreparing(staff, placed.id);
    expect(preparing.status).toBe(OrderStatus.PREPARING);
    expect(preparing.preparingAt).not.toBeNull();

    const ready = await orders.markReady(staff, placed.id);
    expect(ready.status).toBe(OrderStatus.READY);

    // A delivery order cannot be marked collected at the counter.
    await expect(orders.completePickup(staff, placed.id)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    // Re-preparing a ready order is not a legal move.
    await expect(orders.markPreparing(staff, placed.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('completes a pickup order at the counter', async () => {
    const { branch, product, customer } = await scene();
    const staff = ownerActor();

    const placed = await orders.placeOrder(customerActor(customer.id), {
      branchId: branch.id,
      type: 'PICKUP',
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      items: [{ productId: product.id, quantity: 1 }],
    });

    await orders.markPreparing(staff, placed.id);
    await orders.markReady(staff, placed.id);
    const done = await orders.completePickup(staff, placed.id);

    expect(done.status).toBe(OrderStatus.DELIVERED);
    expect(done.deliveredAt).not.toBeNull();
  });

  // --- Cancellation ----------------------------------------------------------

  it('lets a customer cancel before preparation but not after', async () => {
    const { branch, product, customer } = await scene();
    const staff = ownerActor();

    const placed = await orders.placeOrder(customerActor(customer.id), {
      branchId: branch.id,
      type: 'PICKUP',
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      items: [{ productId: product.id, quantity: 1 }],
    });

    // At CONFIRMED, the customer may still cancel.
    const cancelled = await orders.cancelByCustomer(customerActor(customer.id), placed.id, {
      reason: 'Changed my mind',
    });
    expect(cancelled.status).toBe(OrderStatus.CANCELLED);
    expect(cancelled.cancellationReason).toBe('Changed my mind');

    // A second order taken into the kitchen can no longer be self-cancelled.
    const second = await orders.placeOrder(customerActor(customer.id), {
      branchId: branch.id,
      type: 'PICKUP',
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      items: [{ productId: product.id, quantity: 1 }],
    });
    await orders.markPreparing(staff, second.id);

    await expect(
      orders.cancelByCustomer(customerActor(customer.id), second.id, { reason: 'Too late' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  // --- Branch isolation ------------------------------------------------------

  it('isolates orders to the staff member’s branches', async () => {
    const a = await scene();
    const b = await scene();

    const orderA = await orders.placeOrder(customerActor(a.customer.id), {
      branchId: a.branch.id,
      type: 'PICKUP',
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      items: [{ productId: a.product.id, quantity: 1 }],
    });

    const staffOfB = branchStaffActor('staff-b', [b.branch.id]);

    // Staff of branch B cannot read or act on branch A's order.
    await expect(orders.getForStaff(staffOfB, orderA.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(orders.markPreparing(staffOfB, orderA.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    // And a listing for branch B does not include branch A's order.
    const listed = await orders.listForStaff(staffOfB, { page: 1, limit: 100, skip: 0 });
    expect(listed.data.some((o) => o.id === orderA.id)).toBe(false);

    // The owner sees it.
    const ownerView = await orders.getForStaff(ownerActor(), orderA.id);
    expect(ownerView.id).toBe(orderA.id);
  });

  describe('staff order lookup', () => {
    it('finds an order by its full 12-digit reference', async () => {
      const { branch, product, customer } = await scene();
      const order = await orders.placeOrder(customerActor(customer.id), {
        branchId: branch.id,
        type: 'PICKUP',
        paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
        items: [{ productId: product.id, quantity: 1 }],
      });

      const found = await orders.listForStaff(ownerActor(), {
        page: 1,
        limit: 20,
        skip: 0,
        search: order.referenceId,
      });

      expect(found.data.map((o) => o.id)).toEqual([order.id]);
    });

    it('finds it from a partial reference, as read off a docket over the phone', async () => {
      const { branch, product, customer } = await scene();
      const order = await orders.placeOrder(customerActor(customer.id), {
        branchId: branch.id,
        type: 'PICKUP',
        paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
        items: [{ productId: product.id, quantity: 1 }],
      });

      const found = await orders.listForStaff(ownerActor(), {
        page: 1,
        limit: 20,
        skip: 0,
        search: order.referenceId.slice(0, 6),
      });

      expect(found.data.some((o) => o.id === order.id)).toBe(true);
    });

    it('finds an order by its branch order number and by the customer phone', async () => {
      const { branch, product, customer } = await scene();
      const order = await orders.placeOrder(customerActor(customer.id), {
        branchId: branch.id,
        type: 'PICKUP',
        paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
        items: [{ productId: product.id, quantity: 1 }],
      });

      const byNumber = await orders.listForStaff(ownerActor(), {
        page: 1,
        limit: 20,
        skip: 0,
        search: order.orderNumber,
      });
      expect(byNumber.data.some((o) => o.id === order.id)).toBe(true);

      const byPhone = await orders.listForStaff(ownerActor(), {
        page: 1,
        limit: 20,
        skip: 0,
        search: customer.phone,
      });
      expect(byPhone.data.some((o) => o.id === order.id)).toBe(true);
    });

    it('never lets a search reach past the caller’s branch scope', async () => {
      const a = await scene();
      const b = await scene();

      const orderA = await orders.placeOrder(customerActor(a.customer.id), {
        branchId: a.branch.id,
        type: 'PICKUP',
        paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
        items: [{ productId: a.product.id, quantity: 1 }],
      });

      // Branch B's staff know branch A's exact reference and still find nothing:
      // the search widens what is matched, never whose.
      const staffOfB = branchStaffActor('staff-b-search', [b.branch.id]);
      const found = await orders.listForStaff(staffOfB, {
        page: 1,
        limit: 20,
        skip: 0,
        search: orderA.referenceId,
      });

      expect(found.data).toHaveLength(0);
      expect(found.meta.total).toBe(0);
    });

    it('ignores a blank search rather than matching nothing', async () => {
      const { branch, product, customer } = await scene();
      const order = await orders.placeOrder(customerActor(customer.id), {
        branchId: branch.id,
        type: 'PICKUP',
        paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
        items: [{ productId: product.id, quantity: 1 }],
      });

      const found = await orders.listForStaff(ownerActor(), {
        page: 1,
        limit: 100,
        skip: 0,
        search: '   ',
      });

      expect(found.data.some((o) => o.id === order.id)).toBe(true);
    });
  });

  it("hides a customer's order from another customer", async () => {
    const { branch, product, customer } = await scene();
    const other = await createCustomer(prisma);

    const order = await orders.placeOrder(customerActor(customer.id), {
      branchId: branch.id,
      type: 'PICKUP',
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      items: [{ productId: product.id, quantity: 1 }],
    });

    await expect(orders.getForCustomer(customerActor(other.id), order.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // --- Counter orders (Branch POS) -------------------------------------------

  // Random per call (like the customer factory) so a shared test DB that is not
  // wiped between runs never collides on the unique phone.
  function newPhone(): string {
    return `+96650${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
  }

  it('places a counter pickup order for a new customer, priced server-side', async () => {
    const { branch, product } = await scene({ deliveryFeeMinor: 1150 });
    const phone = newPhone();

    const order = await orders.placeOrderForStaff(ownerActor(), {
      branchId: branch.id,
      type: 'PICKUP',
      customerPhone: phone,
      customerName: 'Walk In',
      paymentMethod: PaymentMethod.CASH,
      items: [{ productId: product.id, quantity: 1 }],
    });

    // Priced from the catalog, not the request; pickup has no delivery fee.
    expect(order.totalMinor).toBe(11_500);
    expect(order.deliveryFeeMinor).toBe(0);
    expect(order.status).toBe(OrderStatus.CONFIRMED);
    // A new customer was created from the phone, unverified.
    const created = await prisma.customer.findUnique({ where: { phone } });
    expect(created).not.toBeNull();
    expect(created?.fullName).toBe('Walk In');
    expect(created?.phoneVerifiedAt).toBeNull();
    expect(order.customerId).toBe(created?.id);
    // Placed → confirmed, attributed to the staff member.
    expect(order.statusHistory.map((h) => h.toStatus)).toEqual([
      OrderStatus.PENDING_PAYMENT,
      OrderStatus.CONFIRMED,
    ]);
    expect(order.statusHistory[1].changedByUserId).toBe(ownerUserId);
  });

  it('records cash as paid only when collected up front', async () => {
    const { branch, product } = await scene();

    const unpaid = await orders.placeOrderForStaff(ownerActor(), {
      branchId: branch.id,
      type: 'PICKUP',
      customerPhone: newPhone(),
      paymentMethod: PaymentMethod.CASH,
      items: [{ productId: product.id, quantity: 1 }],
    });
    expect(unpaid.paymentStatus).toBe(PaymentStatus.PENDING);
    const pendingPay = await prisma.payment.findFirst({ where: { orderId: unpaid.id } });
    expect(pendingPay?.method).toBe(PaymentMethod.CASH);
    expect(pendingPay?.status).toBe(PaymentStatus.PENDING);
    expect(pendingPay?.capturedAmountMinor).toBe(0);
    expect(pendingPay?.gatewayName).toBe('counter-cash');

    const paid = await orders.placeOrderForStaff(ownerActor(), {
      branchId: branch.id,
      type: 'PICKUP',
      customerPhone: newPhone(),
      paymentMethod: PaymentMethod.CASH,
      cashCollected: true,
      items: [{ productId: product.id, quantity: 1 }],
    });
    expect(paid.paymentStatus).toBe(PaymentStatus.PAID);
    const paidPay = await prisma.payment.findFirst({ where: { orderId: paid.id } });
    expect(paidPay?.status).toBe(PaymentStatus.PAID);
    expect(paidPay?.capturedAmountMinor).toBe(paid.totalMinor);
    expect(paidPay?.capturedAt).not.toBeNull();
  });

  it('reuses an existing customer by phone rather than duplicating', async () => {
    const { branch, product } = await scene();
    const phone = newPhone();
    const existing = await createCustomer(prisma, { phone });

    const order = await orders.placeOrderForStaff(ownerActor(), {
      branchId: branch.id,
      type: 'PICKUP',
      customerPhone: phone,
      customerName: 'Ignored For Existing',
      paymentMethod: PaymentMethod.CASH,
      items: [{ productId: product.id, quantity: 1 }],
    });

    expect(order.customerId).toBe(existing.id);
    expect(await prisma.customer.count({ where: { phone } })).toBe(1);
  });

  it('takes a counter delivery order and saves the entered address for its delivery leg', async () => {
    const { branch, product } = await scene({ deliveryFeeMinor: 1150 });
    const staff = ownerActor();

    const order = await orders.placeOrderForStaff(staff, {
      branchId: branch.id,
      type: 'DELIVERY',
      customerPhone: newPhone(),
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      deliveryAddress: { line1: '42 Counter St', city: 'Riyadh', notes: 'Gate code 1234' },
      items: [{ productId: product.id, quantity: 1 }],
    });

    expect(order.totalMinor).toBe(12_650);
    expect(order.customerAddressId).not.toBeNull();
    const address = await prisma.customerAddress.findUnique({
      where: { id: order.customerAddressId as string },
    });
    expect(address?.line1).toBe('42 Counter St');
    expect(address?.customerId).toBe(order.customerId);

    // The normal delivery leg opens at READY, on the saved address snapshot.
    await orders.markPreparing(staff, order.id);
    await orders.markReady(staff, order.id);
    const delivery = await prisma.delivery.findUnique({ where: { orderId: order.id } });
    expect(delivery).not.toBeNull();
    expect(delivery?.branchId).toBe(branch.id);
  });

  it('parks a counter order on a manual-accept branch in AWAITING_ACCEPTANCE', async () => {
    const { branch, product } = await scene();
    await prisma.branchSetting.update({
      where: { branchId: branch.id },
      data: { autoAcceptOrders: false },
    });

    const order = await orders.placeOrderForStaff(ownerActor(), {
      branchId: branch.id,
      type: 'PICKUP',
      customerPhone: newPhone(),
      paymentMethod: PaymentMethod.CASH,
      items: [{ productId: product.id, quantity: 1 }],
    });

    expect(order.status).toBe(OrderStatus.AWAITING_ACCEPTANCE);
  });

  it('isolates counter-order creation to the staff member’s branch', async () => {
    const a = await scene();
    const staffOfElsewhere = branchStaffActor('counter-staff-x', ['some-other-branch']);

    await expect(
      orders.placeOrderForStaff(staffOfElsewhere, {
        branchId: a.branch.id,
        type: 'PICKUP',
        customerPhone: newPhone(),
        paymentMethod: PaymentMethod.CASH,
        items: [{ productId: a.product.id, quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses COD at the counter for a pickup order', async () => {
    const { branch, product } = await scene();

    await expect(
      orders.placeOrderForStaff(ownerActor(), {
        branchId: branch.id,
        type: 'PICKUP',
        customerPhone: newPhone(),
        paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
        items: [{ productId: product.id, quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a counter order from a non-staff caller', async () => {
    const { branch, product, customer } = await scene();

    await expect(
      orders.placeOrderForStaff(customerActor(customer.id), {
        branchId: branch.id,
        type: 'PICKUP',
        customerPhone: newPhone(),
        paymentMethod: PaymentMethod.CASH,
        items: [{ productId: product.id, quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // --- Kitchen queue ---------------------------------------------------------

  it('returns the live kitchen queue for a branch, oldest first', async () => {
    const { branch, product, customer } = await scene();
    const staff = ownerActor();

    const first = await orders.placeOrder(customerActor(customer.id), {
      branchId: branch.id,
      type: 'PICKUP',
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      items: [{ productId: product.id, quantity: 1 }],
    });
    const second = await orders.placeOrder(customerActor(customer.id), {
      branchId: branch.id,
      type: 'PICKUP',
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      items: [{ productId: product.id, quantity: 1 }],
    });

    const queue = await orders.kitchenQueue(staff, branch.id);
    const ids = queue.map((o) => o.id);
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);
    expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(second.id));
  });
});
