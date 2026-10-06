import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  DeliveryStatus,
  LoyaltyTransactionType,
  OrderStatus,
  PaymentStatus,
  PrismaClient,
  VehicleType,
} from '@prisma/client';

import { ActorKind, type Actor } from '../../src/auth/types/actor';
import { AppConfigModule } from '../../src/config/config.module';
import { CashCollectionService } from '../../src/delivery/cash-collection.service';
import { DeliveryModule } from '../../src/delivery/delivery.module';
import { DeliveryService } from '../../src/delivery/delivery.service';
import { DriversModule } from '../../src/drivers/drivers.module';
import { DriversService } from '../../src/drivers/drivers.service';
import { MenuModule } from '../../src/menu/menu.module';
import { OrdersModule } from '../../src/orders/orders.module';
import { OrdersService } from '../../src/orders/orders.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { RealtimeService } from '../../src/realtime/realtime.service';
import { VatModule } from '../../src/vat/vat.module';
import {
  createBranch,
  createCategory,
  createCustomer,
  createProduct,
  unique,
} from './helpers/factories';

/**
 * Delivery (Phase 14) against a real database.
 *
 * Proves the whole delivery leg end to end: `OrdersService` opens a `Delivery`
 * the moment a delivery order goes READY and cancels it if the order is
 * cancelled before pickup; assignment and every driver-initiated move keep
 * `Delivery.status` and `Order.status` in lockstep in one transaction; a
 * driver can only ever reach their own deliveries; and a post-pickup failure
 * is recorded without illegally touching the order.
 */
describe('DeliveryService (integration)', () => {
  const prisma = new PrismaClient();
  let orders: OrdersService;
  let drivers: DriversService;
  let delivery: DeliveryService;
  let cash: CashCollectionService;
  /**
   * The real service, with no socket transport registered — every emit is a
   * silent no-op. That is what lets these tests spy on **which** event was
   * routed where without standing up a websocket server.
   */
  let realtime: RealtimeService;
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
        DriversModule,
        DeliveryModule,
      ],
    }).compile();

    const app = moduleRef.createNestApplication();
    await app.init();

    orders = app.get(OrdersService);
    drivers = app.get(DriversService);
    delivery = app.get(DeliveryService);
    cash = app.get(CashCollectionService);
    realtime = app.get(RealtimeService, { strict: false });
    close = () => app.close();
  });

  afterAll(async () => {
    await close?.();
    await prisma.$disconnect();
  });

  // --- Fixtures ----------------------------------------------------------------

  const roleNamed = async (name: string) =>
    prisma.role.upsert({ where: { name }, update: {}, create: { name, isSystem: true } });

  function customerActor(id: string): Actor {
    return {
      kind: ActorKind.Customer,
      id,
      phone: '+966500000000',
      permissions: new Set(),
      branchScope: { kind: 'NONE' },
    };
  }

  function ownerActor(id: string): Actor {
    return {
      kind: ActorKind.Staff,
      id,
      email: 'owner@test',
      fullName: 'Owner',
      roles: ['OWNER'],
      permissions: new Set([
        'orders:read',
        'orders:kitchen',
        'orders:cancel',
        'deliveries:read',
        'deliveries:assign',
      ]),
      branchScope: { kind: 'ALL' },
    };
  }

  /**
   * An owner-scoped actor for calls that only need branch reach, not
   * attribution — driver profile management writes no user-attributed rows.
   */
  function systemOwnerActor(): Actor {
    return {
      kind: ActorKind.Staff,
      id: 'system',
      email: 'system@test',
      fullName: 'System',
      roles: ['OWNER'],
      permissions: new Set(['drivers:read', 'drivers:write']),
      branchScope: { kind: 'ALL' },
    };
  }

  function driverActor(userId: string): Actor {
    return {
      kind: ActorKind.Staff,
      id: userId,
      email: `${userId}@test`,
      fullName: 'Test Driver',
      roles: ['DRIVER'],
      permissions: new Set(['deliveries:own']),
      branchScope: { kind: 'NONE' },
    };
  }

  async function createOwner() {
    return prisma.user.create({
      data: { email: `${unique('owner')}@test`, fullName: 'Owner', passwordHash: 'x' },
    });
  }

  /** A DRIVER-role user with a driver profile, online and available. */
  async function createAvailableDriver() {
    const user = await prisma.user.create({
      data: { email: `${unique('driver')}@test`, fullName: 'Test Driver', passwordHash: 'x' },
    });
    const branch = await createBranch(prisma);
    const role = await roleNamed('DRIVER');
    await prisma.userRole.create({
      data: { userId: user.id, roleId: role.id, branchId: branch.id },
    });

    const profile = await drivers.createProfile(systemOwnerActor(), {
      userId: user.id,
      vehicleType: VehicleType.MOTORCYCLE,
    });
    await drivers.setOnlineStatus(driverActor(user.id), true);

    return { userId: user.id, driverId: profile.id };
  }

  /** A DELIVERY order for one branch, driven to READY so its Delivery leg is open. */
  async function readyDeliveryOrder(ownerId: string) {
    const branch = await createBranch(prisma);
    await prisma.branchSetting.create({
      data: { branchId: branch.id, acceptsCashOnDelivery: true, minOrderMinor: 0 },
    });
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, { basePriceMinor: 5000 });
    await prisma.productAvailability.create({
      data: { productId: product.id, branchId: branch.id, isAvailable: true },
    });
    const customer = await createCustomer(prisma);
    const address = await prisma.customerAddress.create({
      data: {
        customerId: customer.id,
        label: 'Home',
        line1: '1 Test St',
        city: 'Riyadh',
        latitude: 24.7136,
        longitude: 46.6753,
      },
    });

    const order = await orders.placeOrder(customerActor(customer.id), {
      branchId: branch.id,
      type: 'DELIVERY',
      paymentMethod: 'CASH_ON_DELIVERY',
      customerAddressId: address.id,
      items: [{ productId: product.id, quantity: 1 }],
    });

    const actor = ownerActor(ownerId);
    await orders.markPreparing(actor, order.id);
    await orders.markReady(actor, order.id);

    const opened = await prisma.delivery.findUniqueOrThrow({ where: { orderId: order.id } });
    return { branch, order, deliveryId: opened.id, addressId: address.id };
  }

  // --- Opening and cancelling the delivery leg (OrdersService cascade) --------

  it('opens a delivery snapshotting the address the moment the order is ready', async () => {
    const owner = await createOwner();
    const { order, deliveryId, addressId, branch } = await readyDeliveryOrder(owner.id);

    const opened = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(opened.status).toBe(DeliveryStatus.PENDING_ASSIGNMENT);
    expect(opened.branchId).toBe(branch.id);
    expect(opened.orderId).toBe(order.id);

    const address = await prisma.customerAddress.findUniqueOrThrow({ where: { id: addressId } });
    const snapshot = opened.addressSnapshot as { line1: string; latitude: number | null };
    expect(snapshot.line1).toBe(address.line1);
    expect(snapshot.latitude).toBeCloseTo(24.7136, 4);

    const history = await prisma.deliveryStatusHistory.findMany({ where: { deliveryId } });
    expect(history.map((h) => h.toStatus)).toEqual([DeliveryStatus.PENDING_ASSIGNMENT]);
  });

  it('never opens a delivery for a pickup order', async () => {
    const owner = await createOwner();
    const branch = await createBranch(prisma);
    await prisma.branchSetting.create({
      data: { branchId: branch.id, acceptsCashOnDelivery: true, minOrderMinor: 0 },
    });
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, { basePriceMinor: 5000 });
    await prisma.productAvailability.create({
      data: { productId: product.id, branchId: branch.id, isAvailable: true },
    });
    const customer = await createCustomer(prisma);

    const order = await orders.placeOrder(customerActor(customer.id), {
      branchId: branch.id,
      type: 'PICKUP',
      paymentMethod: 'CASH_ON_DELIVERY',
      items: [{ productId: product.id, quantity: 1 }],
    });
    const actor = ownerActor(owner.id);
    await orders.markPreparing(actor, order.id);
    await orders.markReady(actor, order.id);

    expect(await prisma.delivery.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('cancels the open delivery when staff cancel the order before pickup', async () => {
    const owner = await createOwner();
    const { order, deliveryId } = await readyDeliveryOrder(owner.id);

    await orders.cancelByStaff(ownerActor(owner.id), order.id, { reason: 'Out of stock' });

    const cancelled = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(cancelled.status).toBe(DeliveryStatus.CANCELLED);
    expect(cancelled.cancelledAt).toBeTruthy();
  });

  it('frees the driver when an assigned delivery is cancelled with the order', async () => {
    const owner = await createOwner();
    const { order, deliveryId } = await readyDeliveryOrder(owner.id);
    const { userId, driverId } = await createAvailableDriver();

    await delivery.assignDriver(ownerActor(owner.id), deliveryId, { driverId });
    expect((await prisma.driver.findUniqueOrThrow({ where: { id: driverId } })).isAvailable).toBe(
      false,
    );

    await orders.cancelByStaff(ownerActor(owner.id), order.id, { reason: 'Customer cancelled' });

    const freedDriver = await prisma.driver.findUniqueOrThrow({ where: { id: driverId } });
    expect(freedDriver.isAvailable).toBe(true);
    void userId;
  });

  // --- Assignment ---------------------------------------------------------------

  it('assigning a driver moves the delivery and the order together', async () => {
    const owner = await createOwner();
    const { order, deliveryId } = await readyDeliveryOrder(owner.id);
    const { driverId } = await createAvailableDriver();

    const assigned = await delivery.assignDriver(ownerActor(owner.id), deliveryId, { driverId });
    expect(assigned.status).toBe(DeliveryStatus.ASSIGNED);
    expect(assigned.driverId).toBe(driverId);

    const reloadedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloadedOrder.status).toBe(OrderStatus.DRIVER_ASSIGNED);
  });

  /**
   * The rule the counter actually needed. A driver holding a job used to be
   * unassignable, so a second drop for the same street had to wait until they
   * came back — with the food already on the pass.
   */
  it('stacks a second delivery onto a driver already carrying one', async () => {
    const owner = await createOwner();
    const first = await readyDeliveryOrder(owner.id);
    const second = await readyDeliveryOrder(owner.id);
    const { driverId } = await createAvailableDriver();

    await delivery.assignDriver(ownerActor(owner.id), first.deliveryId, { driverId });
    const stacked = await delivery.assignDriver(ownerActor(owner.id), second.deliveryId, {
      driverId,
    });

    expect(stacked.status).toBe(DeliveryStatus.ASSIGNED);
    expect(stacked.driverId).toBe(driverId);

    const both = await prisma.delivery.count({
      where: { driverId, status: DeliveryStatus.ASSIGNED },
    });
    expect(both).toBe(2);
  });

  /**
   * The other half of stacking, and the one that would have been silently
   * wrong: `releaseAfterDelivery` used to free a driver unconditionally, so
   * signing for the first of three drops put them back in the counter's "free"
   * column while they were still riding.
   */
  it('keeps a driver busy until their last drop is done', async () => {
    const owner = await createOwner();
    const first = await readyDeliveryOrder(owner.id);
    const second = await readyDeliveryOrder(owner.id);
    const { userId, driverId } = await createAvailableDriver();

    await delivery.assignDriver(ownerActor(owner.id), first.deliveryId, { driverId });
    await delivery.assignDriver(ownerActor(owner.id), second.deliveryId, { driverId });

    await delivery.markPickedUp(driverActor(userId), first.deliveryId, {});
    await delivery.markDelivered(driverActor(userId), first.deliveryId, { proofType: 'NONE' });

    const midRun = await prisma.driver.findUniqueOrThrow({ where: { id: driverId } });
    expect(midRun.isAvailable).toBe(false);

    await delivery.markPickedUp(driverActor(userId), second.deliveryId, {});
    await delivery.markDelivered(driverActor(userId), second.deliveryId, { proofType: 'NONE' });

    const afterLast = await prisma.driver.findUniqueOrThrow({ where: { id: driverId } });
    expect(afterLast.isAvailable).toBe(true);
  });

  /**
   * Coordinates cross the API as numbers.
   *
   * `Driver.currentLatitude` is a `Decimal` column and `Prisma.Decimal`
   * serialises to a JSON **string** — so this payload used to carry `"24.72"`
   * where every client's type said `number`. It crashed the customer's tracking
   * screen (`.toFixed` on a string, inside render) and left the owner's fleet
   * map on its fallback centre, because a string is not a `LatLng`. Neither
   * side's typechecker could see it; only a test that looks at the value can.
   */
  it('serialises the driver’s position as numbers, not Decimal strings', async () => {
    const owner = await createOwner();
    const { order, deliveryId } = await readyDeliveryOrder(owner.id);
    const { userId, driverId } = await createAvailableDriver();
    await delivery.assignDriver(ownerActor(owner.id), deliveryId, { driverId });
    await drivers.updateLocation(driverActor(userId), 24.7241234, 46.6812345);

    const customerId = (
      await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        select: { customerId: true },
      })
    ).customerId;
    const tracking = await delivery.getTrackingForCustomer(customerId, order.id);

    expect(typeof tracking.driver?.currentLatitude).toBe('number');
    expect(typeof tracking.driver?.currentLongitude).toBe('number');
    expect(tracking.driver?.currentLatitude).toBeCloseTo(24.7241234, 6);

    const staffView = await delivery.getForStaff(ownerActor(owner.id), deliveryId);
    expect(typeof staffView.driver?.currentLatitude).toBe('number');

    const listed = await drivers.listForStaff(systemOwnerActor(), { skip: 0, limit: 50 } as never);
    const row = listed.data.find((d) => d.id === driverId);
    expect(typeof row?.currentLatitude).toBe('number');
    // And the load the counter's picker reads.
    expect(row?.activeDeliveryCount).toBe(1);
  });

  /**
   * The half of the stacking change that is easy to get wrong.
   *
   * `isAvailable: false` now means two things — carrying work, and having
   * stepped away for a break — and only the first is assignable. Reading the
   * flag alone would have made the break switch a control that controls
   * nothing, which is worse than not having one.
   */
  it('refuses a driver who has stepped away, while still stacking onto a busy one', async () => {
    const owner = await createOwner();
    const { deliveryId } = await readyDeliveryOrder(owner.id);
    const { userId, driverId } = await createAvailableDriver();

    await drivers.setAvailability(driverActor(userId), false);

    await expect(
      delivery.assignDriver(ownerActor(owner.id), deliveryId, { driverId }),
    ).rejects.toThrow(/stepped away/);

    // Back from the break, and assignable again.
    await drivers.setAvailability(driverActor(userId), true);
    const assigned = await delivery.assignDriver(ownerActor(owner.id), deliveryId, { driverId });
    expect(assigned.driverId).toBe(driverId);
  });

  it('refuses to assign a driver who is off shift', async () => {
    const owner = await createOwner();
    const { deliveryId } = await readyDeliveryOrder(owner.id);
    const user = await prisma.user.create({
      data: { email: `${unique('offline')}@test`, fullName: 'Offline Driver', passwordHash: 'x' },
    });
    const branch = await createBranch(prisma);
    const role = await roleNamed('DRIVER');
    await prisma.userRole.create({
      data: { userId: user.id, roleId: role.id, branchId: branch.id },
    });
    const offlineDriver = await drivers.createProfile(systemOwnerActor(), {
      userId: user.id,
      vehicleType: VehicleType.CAR,
    });

    await expect(
      delivery.assignDriver(ownerActor(owner.id), deliveryId, { driverId: offlineDriver.id }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('isolates deliveries to the staff member’s branches', async () => {
    const owner = await createOwner();
    const { deliveryId } = await readyDeliveryOrder(owner.id);
    const outsider: Actor = {
      kind: ActorKind.Staff,
      id: `outside-${unique('u')}`,
      email: 'outside@test',
      fullName: 'Outside Staff',
      roles: ['BRANCH_ADMIN'],
      permissions: new Set(['deliveries:read']),
      branchScope: { kind: 'ASSIGNED', branchIds: [(await createBranch(prisma)).id] },
    };

    await expect(delivery.getForStaff(outsider, deliveryId)).rejects.toThrow(/do not have access/);
  });

  // --- The driver leg -------------------------------------------------------------

  it('walks a delivery from assignment to drop-off, keeping the order in step', async () => {
    const owner = await createOwner();
    const { order, deliveryId } = await readyDeliveryOrder(owner.id);
    const { userId, driverId } = await createAvailableDriver();
    const actor = driverActor(userId);

    await delivery.assignDriver(ownerActor(owner.id), deliveryId, { driverId });

    const pickedUp = await delivery.markPickedUp(actor, deliveryId, {});
    expect(pickedUp.status).toBe(DeliveryStatus.PICKED_UP);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      OrderStatus.PICKED_UP,
    );

    const outForDelivery = await delivery.markOutForDelivery(actor, deliveryId, {
      latitude: 24.72,
      longitude: 46.68,
    });
    expect(outForDelivery.status).toBe(DeliveryStatus.OUT_FOR_DELIVERY);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      OrderStatus.OUT_FOR_DELIVERY,
    );

    const delivered = await delivery.markDelivered(actor, deliveryId, {
      proofType: 'NONE',
      recipientName: 'Test Customer',
    });
    expect(delivered.status).toBe(DeliveryStatus.DELIVERED);
    expect(delivered.deliveredAt).toBeTruthy();

    const finalOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(finalOrder.status).toBe(OrderStatus.DELIVERED);

    // The driver is freed for another job.
    expect((await prisma.driver.findUniqueOrThrow({ where: { id: driverId } })).isAvailable).toBe(
      true,
    );

    // Loyalty earns on delivery, same as the direct-pickup path (Phase 17).
    const earned = await prisma.loyaltyTransaction.findFirst({
      where: { orderId: order.id, type: LoyaltyTransactionType.EARN },
    });
    expect(earned).toBeTruthy();

    // A customer notification was recorded for the delivered event.
    const notified = await prisma.notification.findFirst({
      where: { orderId: order.id, type: 'ORDER_DELIVERED' },
    });
    expect(notified).toBeTruthy();
  });

  // --- Reassignment ----------------------------------------------------------

  it('takes a delivery back off its driver and lets someone else take it', async () => {
    // There was no way to move a delivery to another driver: no ASSIGNED →
    // ASSIGNED edge and no unassign path, so a driver who went off shift left
    // the job stranded and the only escape was cancelling the order.
    const owner = await createOwner();
    const { order, deliveryId } = await readyDeliveryOrder(owner.id);
    const first = await createAvailableDriver();
    await delivery.assignDriver(ownerActor(owner.id), deliveryId, { driverId: first.driverId });

    const freed = await delivery.unassignDriver(ownerActor(owner.id), deliveryId, 'shift ended');

    expect(freed.status).toBe(DeliveryStatus.PENDING_ASSIGNMENT);
    expect(freed.driverId).toBeNull();

    // The order is back where it was before assignment, and the driver is free.
    const afterOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(afterOrder.status).toBe(OrderStatus.READY);
    const afterDriver = await prisma.driver.findUniqueOrThrow({ where: { id: first.driverId } });
    expect(afterDriver.isAvailable).toBe(true);

    // And it can now go to someone else, which was the point.
    const second = await createAvailableDriver();
    const reassigned = await delivery.assignDriver(ownerActor(owner.id), deliveryId, {
      driverId: second.driverId,
    });
    expect(reassigned.driverId).toBe(second.driverId);
  });

  it('records why the delivery was taken back', async () => {
    const owner = await createOwner();
    const { deliveryId } = await readyDeliveryOrder(owner.id);
    const { driverId } = await createAvailableDriver();
    await delivery.assignDriver(ownerActor(owner.id), deliveryId, { driverId });

    await delivery.unassignDriver(ownerActor(owner.id), deliveryId, 'phone died');

    // Newest first: the delivery already has an opening PENDING_ASSIGNMENT row
    // from when it was created, and this one is the unassignment.
    const history = await prisma.deliveryStatusHistory.findFirst({
      where: { deliveryId, toStatus: DeliveryStatus.PENDING_ASSIGNMENT },
      orderBy: { createdAt: 'desc' },
    });
    expect(history?.fromStatus).toBe(DeliveryStatus.ASSIGNED);
    expect(history?.note).toBe('phone died');
  });

  // --- Telling the driver ------------------------------------------------------

  it('routes the assignment and the take-back to the driver’s own channel', async () => {
    // The driver app learned about a job from an eight-second poll and nothing
    // else, so "the counter assigned it" and "the driver knows" were up to
    // eight seconds apart with the food already on the pass. The realtime
    // events now carry the driver's **user** id, which is what the socket
    // gateway keys a driver's room on (`ROOMS.driver`) — the `Driver.id` the
    // rest of this module works in would reach nobody.
    const assigned = jest.spyOn(realtime, 'deliveryAssigned');
    const unassigned = jest.spyOn(realtime, 'deliveryUnassigned');

    const owner = await createOwner();
    const { deliveryId } = await readyDeliveryOrder(owner.id);
    const { driverId, userId } = await createAvailableDriver();

    await delivery.assignDriver(ownerActor(owner.id), deliveryId, { driverId });
    expect(assigned).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId, driverId, driverUserId: userId }),
    );

    await delivery.unassignDriver(ownerActor(owner.id), deliveryId, 'wrong driver');
    // Read before the transaction clears `driverId` — afterwards there is no
    // link back to the person who has to be told the job is no longer theirs.
    expect(unassigned).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId, driverId, driverUserId: userId }),
    );

    assigned.mockRestore();
    unassigned.mockRestore();
  });

  it('refuses to unassign after pickup', async () => {
    // The food is in the car. Moving the record would lie about where it is;
    // a failed delivery is the honest path.
    const owner = await createOwner();
    const { deliveryId } = await readyDeliveryOrder(owner.id);
    const { userId, driverId } = await createAvailableDriver();
    await delivery.assignDriver(ownerActor(owner.id), deliveryId, { driverId });
    await delivery.markPickedUp(driverActor(userId), deliveryId, {});

    await expect(delivery.unassignDriver(ownerActor(owner.id), deliveryId)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('refuses to deactivate a driver holding work', async () => {
    // Deactivating mid-job used to succeed and strand the delivery.
    const owner = await createOwner();
    const { deliveryId } = await readyDeliveryOrder(owner.id);
    const { driverId } = await createAvailableDriver();
    await delivery.assignDriver(ownerActor(owner.id), deliveryId, { driverId });

    await expect(drivers.deactivate(systemOwnerActor(), driverId)).rejects.toBeInstanceOf(
      ConflictException,
    );

    // Freed, it can be retired.
    await delivery.unassignDriver(ownerActor(owner.id), deliveryId);
    await expect(drivers.deactivate(systemOwnerActor(), driverId)).resolves.toBeDefined();
  });

  // --- Cash on delivery (driver view + reconciliation) -----------------------

  /**
   * The customer's real phone number reaches the assigned driver from pickup
   * onward (owner decision — see `src/delivery/customer-contact.ts`). It
   * replaces a rule that withheld it entirely, so the boundaries are worth
   * holding in a test rather than in a comment.
   */
  describe('calling the customer', () => {
    it('withholds the number until the food is in the car', async () => {
      const owner = await createOwner();
      const { deliveryId } = await readyDeliveryOrder(owner.id);
      const { userId, driverId } = await createAvailableDriver();
      await delivery.assignDriver(ownerActor(owner.id), deliveryId, { driverId });

      const assigned = await delivery.getOwnDelivery(driverActor(userId), deliveryId);
      // Not merely absent from the screen — absent from the payload, so it
      // cannot be read out of a response an app chose not to render.
      expect(assigned.customerPhone).toBeNull();
      expect(assigned.customerName).toBeNull();
    });

    it('gives the assigned driver the real number once they have picked up', async () => {
      const owner = await createOwner();
      const { deliveryId } = await readyDeliveryOrder(owner.id);
      const { userId, driverId } = await createAvailableDriver();
      await delivery.assignDriver(ownerActor(owner.id), deliveryId, { driverId });

      const pickedUp = await delivery.markPickedUp(driverActor(userId), deliveryId, {});

      // Unmasked, by decision. No call-masking provider is contracted and the
      // owner has accepted that trade.
      expect(pickedUp.customerPhone).toMatch(/^\+/);
      expect(pickedUp.customerName).toBeTruthy();
    });

    it('takes the number back the moment the delivery is closed', async () => {
      // A finished delivery is still reachable in the driver app — Home lists
      // past jobs and each opens the delivery screen — so a number that
      // survived the drop would stay one tap from being dialled indefinitely.
      // That is a standing directory of customers on a courier's handset, not
      // the "call them at the door" this was built for.
      const owner = await createOwner();
      const { deliveryId } = await readyDeliveryOrder(owner.id);
      const { userId, driverId } = await createAvailableDriver();
      await delivery.assignDriver(ownerActor(owner.id), deliveryId, { driverId });
      await delivery.markPickedUp(driverActor(userId), deliveryId, {});

      const delivered = await delivery.markDelivered(driverActor(userId), deliveryId, {
        proofType: 'NONE',
      });
      expect(delivered.customerPhone).toBeNull();

      // And it stays gone on every later read, which is the one that matters:
      // the driver reaches a past job through the list, not through the
      // response to the button they just pressed.
      const reRead = await delivery.getOwnDelivery(driverActor(userId), deliveryId);
      expect(reRead.customerPhone).toBeNull();
      expect(reRead.customerName).toBeNull();
    });

    it('is gone from the driver’s own delivery list once the job is done', async () => {
      // `myDeliveries` is what backs the Home screen's past-jobs section, and
      // it is a different code path from a single read.
      const owner = await createOwner();
      const { deliveryId } = await readyDeliveryOrder(owner.id);
      const { userId, driverId } = await createAvailableDriver();
      await delivery.assignDriver(ownerActor(owner.id), deliveryId, { driverId });
      await delivery.markPickedUp(driverActor(userId), deliveryId, {});
      await delivery.markDelivered(driverActor(userId), deliveryId, { proofType: 'NONE' });

      const mine = await delivery.myDeliveries(driverActor(userId), {
        skip: 0,
        limit: 50,
      } as never);
      const row = mine.data.find((d) => d.id === deliveryId);
      expect(row?.customerPhone).toBeNull();
    });

    it('never puts it on the staff view, which was not part of this change', async () => {
      const owner = await createOwner();
      const { deliveryId } = await readyDeliveryOrder(owner.id);
      const { userId, driverId } = await createAvailableDriver();
      await delivery.assignDriver(ownerActor(owner.id), deliveryId, { driverId });
      await delivery.markPickedUp(driverActor(userId), deliveryId, {});

      const staffView = await delivery.getForStaff(ownerActor(owner.id), deliveryId);
      expect(staffView).not.toHaveProperty('customerPhone');
    });

    it('never reaches a driver the delivery does not belong to', async () => {
      // The `who` half of the gate. Ownership is resolved from the caller's own
      // driver record, so another driver gets a 404 rather than a payload with
      // the number filtered out of it.
      const owner = await createOwner();
      const { deliveryId } = await readyDeliveryOrder(owner.id);
      const { userId, driverId } = await createAvailableDriver();
      const outsider = await createAvailableDriver();
      await delivery.assignDriver(ownerActor(owner.id), deliveryId, { driverId });
      await delivery.markPickedUp(driverActor(userId), deliveryId, {});

      await expect(
        delivery.getOwnDelivery(driverActor(outsider.userId), deliveryId),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('exposes the cash-on-delivery amount to the assigned driver', async () => {
    const owner = await createOwner();
    const { order, deliveryId } = await readyDeliveryOrder(owner.id);
    const { userId, driverId } = await createAvailableDriver();
    const actor = driverActor(userId);
    await delivery.assignDriver(ownerActor(owner.id), deliveryId, { driverId });

    const view = await delivery.getOwnDelivery(actor, deliveryId);
    expect(view.isCashOnDelivery).toBe(true);
    expect(view.amountDueMinor).toBe(order.totalMinor);
    expect(view.cashCollection).toBeNull();
    // The order sub-view must never carry raw payment detail to a driver.
    expect('payments' in view.order).toBe(false);
  });

  it('records cash collected against a delivered COD order and computes the variance', async () => {
    const owner = await createOwner();
    const { order, deliveryId } = await readyDeliveryOrder(owner.id);
    const { userId, driverId } = await createAvailableDriver();
    const actor = driverActor(userId);
    await delivery.assignDriver(ownerActor(owner.id), deliveryId, { driverId });
    await delivery.markPickedUp(actor, deliveryId, {});
    await delivery.markDelivered(actor, deliveryId, { proofType: 'NONE' });

    // Driver hands over 10 SAR more than owed (kept the change, say).
    const collectedMinor = order.totalMinor + 1000;
    const record = await cash.recordCollected(actor, deliveryId, {
      collectedMinor,
      note: 'kept change',
    });
    expect(record.expectedMinor).toBe(order.totalMinor);
    expect(record.collectedMinor).toBe(collectedMinor);
    expect(record.varianceMinor).toBe(1000);

    // The record now shows up on the driver's own delivery view.
    const view = await delivery.getOwnDelivery(actor, deliveryId);
    expect(view.cashCollection?.collectedMinor).toBe(collectedMinor);
    expect(view.cashCollection?.varianceMinor).toBe(1000);
  });

  it('settles the COD payment when the full amount is handed over', async () => {
    // Nothing used to move a COD payment off PENDING, so cash orders showed
    // captured 0 in the payments report for ever while the sales report showed
    // the full amount for the same period.
    const owner = await createOwner();
    const { order, deliveryId } = await readyDeliveryOrder(owner.id);
    const { userId, driverId } = await createAvailableDriver();
    const actor = driverActor(userId);
    await delivery.assignDriver(ownerActor(owner.id), deliveryId, { driverId });
    await delivery.markPickedUp(actor, deliveryId, {});
    await delivery.markDelivered(actor, deliveryId, { proofType: 'NONE' });

    await cash.recordCollected(actor, deliveryId, { collectedMinor: order.totalMinor });

    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
    expect(payment.status).toBe(PaymentStatus.PAID);
    expect(payment.capturedAmountMinor).toBe(order.totalMinor);
    expect(payment.capturedAt).not.toBeNull();

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.paymentStatus).toBe(PaymentStatus.PAID);
    // Fulfilment is untouched — the two columns move independently.
    expect(after.status).toBe(OrderStatus.DELIVERED);
  });

  it('captures what was owed, not what was handed over', async () => {
    // A tip or change not given does not increase what the order was worth,
    // and capturing it would overstate revenue against the order snapshot.
    const owner = await createOwner();
    const { order, deliveryId } = await readyDeliveryOrder(owner.id);
    const { userId, driverId } = await createAvailableDriver();
    const actor = driverActor(userId);
    await delivery.assignDriver(ownerActor(owner.id), deliveryId, { driverId });
    await delivery.markPickedUp(actor, deliveryId, {});
    await delivery.markDelivered(actor, deliveryId, { proofType: 'NONE' });

    await cash.recordCollected(actor, deliveryId, { collectedMinor: order.totalMinor + 5000 });

    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
    expect(payment.capturedAmountMinor).toBe(order.totalMinor);
    expect(payment.status).toBe(PaymentStatus.PAID);
  });

  it('leaves a short collection unsettled, with the variance on record', async () => {
    // Recording money that was not handed over as received is the one outcome
    // that must not happen quietly. What a shortfall means — write-off, driver
    // liability, partial capture — is a business decision, so the payment stays
    // pending and the variance is there for a manager.
    const owner = await createOwner();
    const { order, deliveryId } = await readyDeliveryOrder(owner.id);
    const { userId, driverId } = await createAvailableDriver();
    const actor = driverActor(userId);
    await delivery.assignDriver(ownerActor(owner.id), deliveryId, { driverId });
    await delivery.markPickedUp(actor, deliveryId, {});
    await delivery.markDelivered(actor, deliveryId, { proofType: 'NONE' });

    const record = await cash.recordCollected(actor, deliveryId, {
      collectedMinor: order.totalMinor - 500,
    });

    expect(record.varianceMinor).toBe(-500);

    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
    expect(payment.status).toBe(PaymentStatus.PENDING);
    expect(payment.capturedAmountMinor).toBe(0);

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.paymentStatus).toBe(PaymentStatus.PENDING);
  });

  it('refuses cash collection before the delivery is marked delivered', async () => {
    const owner = await createOwner();
    const { deliveryId } = await readyDeliveryOrder(owner.id);
    const { userId, driverId } = await createAvailableDriver();
    const actor = driverActor(userId);
    await delivery.assignDriver(ownerActor(owner.id), deliveryId, { driverId });
    await delivery.markPickedUp(actor, deliveryId, {});

    await expect(
      cash.recordCollected(actor, deliveryId, { collectedMinor: 1000 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a second cash collection for the same delivery', async () => {
    const owner = await createOwner();
    const { order, deliveryId } = await readyDeliveryOrder(owner.id);
    const { userId, driverId } = await createAvailableDriver();
    const actor = driverActor(userId);
    await delivery.assignDriver(ownerActor(owner.id), deliveryId, { driverId });
    await delivery.markPickedUp(actor, deliveryId, {});
    await delivery.markDelivered(actor, deliveryId, { proofType: 'NONE' });

    await cash.recordCollected(actor, deliveryId, { collectedMinor: order.totalMinor });
    await expect(
      cash.recordCollected(actor, deliveryId, { collectedMinor: order.totalMinor }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('requires proof for signature or photo delivery', async () => {
    const owner = await createOwner();
    const { deliveryId } = await readyDeliveryOrder(owner.id);
    const { userId, driverId } = await createAvailableDriver();
    const actor = driverActor(userId);
    await delivery.assignDriver(ownerActor(owner.id), deliveryId, { driverId });
    await delivery.markPickedUp(actor, deliveryId, {});

    await expect(
      delivery.markDelivered(actor, deliveryId, { proofType: 'PHOTO' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lets delivery be reached directly from pickup, skipping out-for-delivery', async () => {
    const owner = await createOwner();
    const { order, deliveryId } = await readyDeliveryOrder(owner.id);
    const { userId, driverId } = await createAvailableDriver();
    const actor = driverActor(userId);
    await delivery.assignDriver(ownerActor(owner.id), deliveryId, { driverId });
    await delivery.markPickedUp(actor, deliveryId, {});

    const delivered = await delivery.markDelivered(actor, deliveryId, { proofType: 'NONE' });
    expect(delivered.status).toBe(DeliveryStatus.DELIVERED);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      OrderStatus.DELIVERED,
    );
  });

  it('records a post-pickup failure without touching the order', async () => {
    const owner = await createOwner();
    const { order, deliveryId } = await readyDeliveryOrder(owner.id);
    const { userId, driverId } = await createAvailableDriver();
    const actor = driverActor(userId);
    await delivery.assignDriver(ownerActor(owner.id), deliveryId, { driverId });
    await delivery.markPickedUp(actor, deliveryId, {});

    const failed = await delivery.markFailed(actor, deliveryId, {
      reason: 'Customer unreachable at the address',
    });
    expect(failed.status).toBe(DeliveryStatus.FAILED);
    expect(failed.failureReason).toBe('Customer unreachable at the address');

    // The order is left exactly where it was — CANCELLED is illegal this late,
    // so it is staff's job to resolve it, not this call's.
    const untouchedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(untouchedOrder.status).toBe(OrderStatus.PICKED_UP);

    // The driver is freed even though the job did not complete.
    expect((await prisma.driver.findUniqueOrThrow({ where: { id: driverId } })).isAvailable).toBe(
      true,
    );
  });

  it('refuses to mark a delivery failed before it has been picked up', async () => {
    const owner = await createOwner();
    const { deliveryId } = await readyDeliveryOrder(owner.id);
    const { userId, driverId } = await createAvailableDriver();
    const actor = driverActor(userId);
    await delivery.assignDriver(ownerActor(owner.id), deliveryId, { driverId });

    await expect(
      delivery.markFailed(actor, deliveryId, { reason: 'Too early' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  // --- Ownership isolation --------------------------------------------------------

  it('never lets a driver reach another driver’s delivery', async () => {
    const owner = await createOwner();
    const { deliveryId } = await readyDeliveryOrder(owner.id);
    const { driverId } = await createAvailableDriver();
    await delivery.assignDriver(ownerActor(owner.id), deliveryId, { driverId });

    const { userId: otherUserId } = await createAvailableDriver();
    const otherActor = driverActor(otherUserId);

    await expect(delivery.getOwnDelivery(otherActor, deliveryId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(delivery.markPickedUp(otherActor, deliveryId, {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
