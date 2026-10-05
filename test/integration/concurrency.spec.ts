import { Test } from '@nestjs/testing';
import { DeliveryStatus, OrderStatus, PaymentMethod, PrismaClient } from '@prisma/client';

import { ActorKind, type Actor } from '../../src/auth/types/actor';
import { AppConfigModule, AppConfigService } from '../../src/config/config.module';
import { IdempotencyModule } from '../../src/common/idempotency/idempotency.module';
import { IdempotencyService } from '../../src/common/idempotency/idempotency.service';
import { DeliveryModule } from '../../src/delivery/delivery.module';
import { DeliveryService } from '../../src/delivery/delivery.service';
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
 * Concurrency, against a real database.
 *
 * Every one of these passes trivially when the calls are made in sequence, and
 * that is the point: the bugs they cover all shipped, all survived a full green
 * suite, and all corrupted data the first time two people acted at once. A test
 * that does not actually race proves nothing about a race.
 *
 * `Promise.allSettled` rather than `all`, because the *expected* outcome is
 * that most of the calls are rejected — that is the fix working.
 */
describe('Concurrency (integration)', () => {
  const prisma = new PrismaClient();
  let orders: OrdersService;
  let delivery: DeliveryService;
  let idempotency: IdempotencyService;
  let stackingCeiling: number;
  let close: () => Promise<void>;
  let staffUserId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        PrismaModule,
        IdempotencyModule,
        VatModule,
        MenuModule,
        OrdersModule,
        DeliveryModule,
      ],
    }).compile();

    const app = await moduleRef.init();
    orders = moduleRef.get(OrdersService);
    delivery = moduleRef.get(DeliveryService);
    idempotency = moduleRef.get(IdempotencyService);
    stackingCeiling = moduleRef.get(AppConfigService).delivery.maxActiveDeliveriesPerDriver;
    close = () => app.close();

    const user = await prisma.user.create({
      data: { email: unique('race'), fullName: 'Race Staff', passwordHash: 'x', isActive: true },
    });
    staffUserId = user.id;
  });

  afterAll(async () => {
    await close();
    await prisma.$disconnect();
  });

  function staffActor(): Actor {
    return {
      kind: ActorKind.Staff,
      id: staffUserId,
      email: 'race@test',
      fullName: 'Race Staff',
      roles: ['OWNER'],
      permissions: new Set(['orders:read', 'orders:kitchen', 'orders:cancel', 'deliveries:assign']),
      branchScope: { kind: 'ALL' },
    };
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

  async function scene() {
    const branch = await createBranch(prisma);
    await prisma.branchSetting.create({
      data: {
        branchId: branch.id,
        acceptsDelivery: true,
        acceptsPickup: true,
        isAcceptingOrders: true,
        acceptsCashOnDelivery: true,
        autoAcceptOrders: true,
      },
    });
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, { basePriceMinor: 10_000 });
    await prisma.productAvailability.create({
      data: { branchId: branch.id, productId: product.id, isAvailable: true },
    });
    const customer = await createCustomer(prisma);

    return { branch, product, customer };
  }

  async function placePickupOrder() {
    const { branch, product, customer } = await scene();

    return orders.placeOrder(customerActor(customer.id), {
      branchId: branch.id,
      type: 'PICKUP',
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      items: [{ productId: product.id, quantity: 1 }],
    });
  }

  // --- Order status ----------------------------------------------------------

  it('applies exactly one of several concurrent identical transitions', async () => {
    const order = await placePickupOrder();

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => orders.markPreparing(staffActor(), order.id)),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const history = await prisma.orderStatusHistory.count({
      where: { orderId: order.id, toStatus: OrderStatus.PREPARING },
    });
    expect(history).toBe(1);
  });

  it('never lets an order be confirmed and cancelled at the same time', async () => {
    // The exact shape that corrupted a real order: accept and cancel fired
    // together both committed, leaving status=CONFIRMED with cancelledAt and a
    // cancellation reason set, and both moves in the history.
    //
    // What this must NOT assert is that only one of the six calls ever wins.
    // `PREPARING -> CANCELLED` is a legal edge, so a correctly-locked run can
    // legitimately serialise two of them: one call moves CONFIRMED -> PREPARING
    // and a later one moves PREPARING -> CANCELLED. That leaves `preparingAt`
    // set on a CANCELLED order, which is accurate history rather than
    // corruption — an order that really was being prepared when it was
    // cancelled. An earlier version of this test asserted `preparingAt` was
    // null whenever the order ended CANCELLED, and so failed roughly one run in
    // four purely on scheduling, with a message that read like a locking bug.
    //
    // The invariant that actually distinguishes the fix from the bug is that
    // every committed move is a legal edge *from the state that move observed*,
    // and the row agrees with the last of them.
    const order = await placePickupOrder();

    await Promise.allSettled([
      ...Array.from({ length: 3 }, () => orders.markPreparing(staffActor(), order.id)),
      ...Array.from({ length: 3 }, () =>
        orders.cancelByStaff(staffActor(), order.id, { reason: 'race' }),
      ),
    ]);

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    const history = await prisma.orderStatusHistory.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: 'asc' },
    });

    // The history is one unbroken chain: each move starts where the previous
    // one ended, and it ends where the order row says it is. A second writer
    // that committed against a stale read shows up here as a break.
    const moves = history.filter((h) => h.fromStatus !== null);
    for (let i = 1; i < moves.length; i += 1) {
      expect(moves[i].fromStatus).toBe(moves[i - 1].toStatus);
    }
    expect(moves.at(-1)?.toStatus ?? OrderStatus.CONFIRMED).toBe(after.status);

    // No status is entered twice — five rejected calls must leave no trace.
    const entered = moves.map((m) => m.toStatus);
    expect(new Set(entered).size).toBe(entered.length);

    // Exactly one move leaves CONFIRMED, whichever of the two won it.
    expect(moves.filter((m) => m.fromStatus === OrderStatus.CONFIRMED)).toHaveLength(1);

    // The row describes one outcome, not two. This is the corruption itself:
    // a cancel that committed against a row it never actually moved left
    // status=CONFIRMED with cancelledAt and a reason set.
    if (after.status === OrderStatus.CANCELLED) {
      expect(after.cancelledAt).not.toBeNull();
      expect(after.cancellationReason).toBe('race');
      // Whether it was prepared first is a matter of ordering, but the two
      // timestamps must agree with the chain that produced them.
      const wasPrepared = entered.includes(OrderStatus.PREPARING);
      expect(after.preparingAt === null).toBe(!wasPrepared);
    } else {
      expect(after.status).toBe(OrderStatus.PREPARING);
      expect(after.preparingAt).not.toBeNull();
      expect(after.cancelledAt).toBeNull();
      expect(after.cancellationReason).toBeNull();
    }
  });

  // --- Delivery assignment ---------------------------------------------------

  async function readyDeliveryOrder() {
    const { branch, product, customer } = await scene();
    const address = await prisma.customerAddress.create({
      data: { customerId: customer.id, line1: '1 Test St', city: 'Riyadh' },
    });

    const order = await orders.placeOrder(customerActor(customer.id), {
      branchId: branch.id,
      type: 'DELIVERY',
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      customerAddressId: address.id,
      items: [{ productId: product.id, quantity: 1 }],
    });

    await orders.markPreparing(staffActor(), order.id);
    await orders.markReady(staffActor(), order.id);

    const row = await prisma.delivery.findUniqueOrThrow({ where: { orderId: order.id } });

    return { branch, order, deliveryId: row.id };
  }

  async function createDriver(): Promise<string> {
    const user = await prisma.user.create({
      data: { email: unique('driver'), fullName: 'Driver', passwordHash: 'x', isActive: true },
    });
    const row = await prisma.driver.create({
      data: { userId: user.id, isOnline: true, isAvailable: true },
    });

    return row.id;
  }

  it('assigns one delivery to exactly one driver', async () => {
    const { deliveryId } = await readyDeliveryOrder();
    const drivers = await Promise.all([
      createDriver(),
      createDriver(),
      createDriver(),
      createDriver(),
    ]);

    const results = await Promise.allSettled(
      drivers.map((driverId) => delivery.assignDriver(staffActor(), deliveryId, { driverId })),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const busy = await prisma.driver.count({ where: { id: { in: drivers }, isAvailable: false } });
    // Three drivers were previously left unavailable holding no job at all.
    expect(busy).toBe(1);

    const assigned = await prisma.deliveryStatusHistory.count({
      where: { deliveryId, toStatus: DeliveryStatus.ASSIGNED },
    });
    expect(assigned).toBe(1);
  });

  /**
   * A driver may now carry more than one drop — that is the point of stacked
   * assignment — but never more than the configured ceiling, and never more
   * than it just because several counters pressed Assign at the same instant.
   *
   * This is the test that made the row lock necessary. The old guard was a
   * conditional `isAvailable: true → false` update, which the database
   * serialised for free; once a busy driver became assignable that guard was
   * gone, four concurrent assignments each read the same count, each passed,
   * and all four landed. Without `SELECT ... FOR UPDATE` in
   * `assertCanTakeAnotherJob` this fails with 4.
   */
  it('never books one driver past the stacking ceiling, however concurrent the presses', async () => {
    const driverId = await createDriver();
    const ceiling = stackingCeiling;
    const deliveries = await Promise.all(
      Array.from({ length: ceiling + 3 }, () => readyDeliveryOrder()),
    );

    const results = await Promise.allSettled(
      deliveries.map((d) => delivery.assignDriver(staffActor(), d.deliveryId, { driverId })),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(ceiling);

    const active = await prisma.delivery.count({
      where: {
        driverId,
        status: {
          in: [DeliveryStatus.ASSIGNED, DeliveryStatus.PICKED_UP, DeliveryStatus.OUT_FOR_DELIVERY],
        },
      },
    });
    expect(active).toBe(ceiling);

    // Carrying anything at all means not free, whether it is one job or the
    // ceiling. That is the invariant `setAvailability` depends on.
    const driver = await prisma.driver.findUniqueOrThrow({ where: { id: driverId } });
    expect(driver.isAvailable).toBe(false);
  });

  // --- Duplicate orders ------------------------------------------------------

  it('places one order for repeated requests carrying the same idempotency key', async () => {
    // The shape that produced duplicates: a client that times out and retries.
    // Without a key, eight identical requests made eight real orders the
    // kitchen would cook.
    const { branch, product, customer } = await scene();
    const key = unique('checkout');
    const body = {
      branchId: branch.id,
      type: 'PICKUP' as const,
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      items: [{ productId: product.id, quantity: 1 }],
    };

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        idempotency.run(`order.place:${customer.id}`, key, body, () =>
          orders.placeOrder(customerActor(customer.id), body),
        ),
      ),
    );

    const placed = await prisma.order.count({ where: { branchId: branch.id } });
    expect(placed).toBe(1);

    // Everyone who got an answer got the same order.
    const numbers = new Set(
      results.flatMap((r) => (r.status === 'fulfilled' ? [r.value.orderNumber] : [])),
    );
    expect(numbers.size).toBe(1);
  });

  // --- Order numbers (already safe; held here so it stays that way) ----------

  it('gives concurrent orders in one branch distinct sequential numbers', async () => {
    const { branch, product, customer } = await scene();

    const placed = await Promise.all(
      Array.from({ length: 8 }, () =>
        orders.placeOrder(customerActor(customer.id), {
          branchId: branch.id,
          type: 'PICKUP',
          paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
          items: [{ productId: product.id, quantity: 1 }],
        }),
      ),
    );

    const numbers = placed.map((o) => Number(o.orderNumber)).sort((a, b) => a - b);

    expect(new Set(numbers).size).toBe(8);
    // Allocated in one atomic statement inside the order transaction, so the
    // series has no gaps either.
    expect(Number(numbers[7]) - Number(numbers[0])).toBe(7);
  });
});
