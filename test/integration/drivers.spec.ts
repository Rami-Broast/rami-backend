import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, VehicleType } from '@prisma/client';

import { ActorKind, type Actor } from '../../src/auth/types/actor';
import { AppConfigModule } from '../../src/config/config.module';
import { DriversModule } from '../../src/drivers/drivers.module';
import { DriversService } from '../../src/drivers/drivers.service';
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
 * Drivers (Phase 14) against a real database.
 *
 * Proves a driver profile can only be provisioned for a real DRIVER-role user,
 * that shift status and availability follow the rules laid out in
 * `DriversService`'s class doc (offline always clears availability; a manual
 * availability change is refused while a delivery is in progress), and that
 * every self-service method resolves ownership by the caller's own user id.
 */
describe('DriversService (integration)', () => {
  const prisma = new PrismaClient();
  let drivers: DriversService;
  let orders: OrdersService;
  let close: () => Promise<void>;
  let ownerUserId: string;

  beforeAll(async () => {
    await prisma.$connect();

    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, PrismaModule, VatModule, MenuModule, OrdersModule, DriversModule],
    }).compile();

    const app = moduleRef.createNestApplication();
    await app.init();

    drivers = app.get(DriversService);
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

  const roleNamed = async (name: string) =>
    prisma.role.upsert({ where: { name }, update: {}, create: { name, isSystem: true } });

  async function createDriverUser() {
    const user = await prisma.user.create({
      data: { email: `${unique('driver')}@test`, fullName: 'Test Driver', passwordHash: 'x' },
    });
    const branch = await createBranch(prisma);
    const role = await roleNamed('DRIVER');
    await prisma.userRole.create({
      data: { userId: user.id, roleId: role.id, branchId: branch.id },
    });
    return user;
  }

  function driverActor(userId: string): Actor {
    return {
      kind: ActorKind.Staff,
      id: userId,
      email: 'driver@test',
      fullName: 'Test Driver',
      roles: ['DRIVER'],
      permissions: new Set(['deliveries:own']),
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
      permissions: new Set(['deliveries:read', 'deliveries:assign']),
      branchScope: { kind: 'ALL' },
    };
  }

  async function readyDeliveryOrder() {
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
      data: { customerId: customer.id, line1: '1 Test St', city: 'Riyadh' },
    });

    const customerActor: Actor = {
      kind: ActorKind.Customer,
      id: customer.id,
      phone: '+966500000000',
      permissions: new Set(),
      branchScope: { kind: 'NONE' },
    };

    const order = await orders.placeOrder(customerActor, {
      branchId: branch.id,
      type: 'DELIVERY',
      paymentMethod: 'CASH_ON_DELIVERY',
      customerAddressId: address.id,
      items: [{ productId: product.id, quantity: 1 }],
    });

    const actor = ownerActor(ownerUserId);
    await orders.markPreparing(actor, order.id);
    await orders.markReady(actor, order.id);

    const delivery = await prisma.delivery.findUniqueOrThrow({ where: { orderId: order.id } });
    return { delivery };
  }

  // --- Provisioning -----------------------------------------------------------

  it('creates a profile only for a user holding the DRIVER role', async () => {
    const staff = await prisma.user.create({
      data: { email: `${unique('nondriver')}@test`, fullName: 'Not A Driver', passwordHash: 'x' },
    });

    await expect(
      drivers.createProfile(ownerActor(ownerUserId), {
        userId: staff.id,
        vehicleType: VehicleType.CAR,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses to provision a second profile for the same user', async () => {
    const user = await createDriverUser();
    await drivers.createProfile(ownerActor(ownerUserId), {
      userId: user.id,
      vehicleType: VehicleType.MOTORCYCLE,
    });

    await expect(
      drivers.createProfile(ownerActor(ownerUserId), {
        userId: user.id,
        vehicleType: VehicleType.CAR,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  // --- Shift status and availability ------------------------------------------

  it('going online makes an idle driver available; going offline always clears it', async () => {
    const user = await createDriverUser();
    await drivers.createProfile(ownerActor(ownerUserId), {
      userId: user.id,
      vehicleType: VehicleType.MOTORCYCLE,
    });
    const actor = driverActor(user.id);

    const online = await drivers.setOnlineStatus(actor, true);
    expect(online.isOnline).toBe(true);
    expect(online.isAvailable).toBe(true);

    const offline = await drivers.setOnlineStatus(actor, false);
    expect(offline.isOnline).toBe(false);
    expect(offline.isAvailable).toBe(false);
  });

  it('refuses to change availability while offline', async () => {
    const user = await createDriverUser();
    await drivers.createProfile(ownerActor(ownerUserId), {
      userId: user.id,
      vehicleType: VehicleType.MOTORCYCLE,
    });
    const actor = driverActor(user.id);

    await expect(drivers.setAvailability(actor, true)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lets an idle driver step away and come back while online', async () => {
    const user = await createDriverUser();
    await drivers.createProfile(ownerActor(ownerUserId), {
      userId: user.id,
      vehicleType: VehicleType.MOTORCYCLE,
    });
    const actor = driverActor(user.id);
    await drivers.setOnlineStatus(actor, true);

    const away = await drivers.setAvailability(actor, false);
    expect(away.isAvailable).toBe(false);

    const back = await drivers.setAvailability(actor, true);
    expect(back.isAvailable).toBe(true);
  });

  it('refuses to change availability while a delivery is in progress', async () => {
    const user = await createDriverUser();
    const driver = await drivers.createProfile(ownerActor(ownerUserId), {
      userId: user.id,
      vehicleType: VehicleType.MOTORCYCLE,
    });
    const actor = driverActor(user.id);
    await drivers.setOnlineStatus(actor, true);

    const { delivery } = await readyDeliveryOrder();
    await prisma.delivery.update({
      where: { id: delivery.id },
      data: { driverId: driver.id, status: 'ASSIGNED' },
    });

    await expect(drivers.setAvailability(actor, false)).rejects.toBeInstanceOf(ConflictException);
  });

  it('reports live location only for the caller’s own profile', async () => {
    const user = await createDriverUser();
    await drivers.createProfile(ownerActor(ownerUserId), {
      userId: user.id,
      vehicleType: VehicleType.MOTORCYCLE,
    });
    const actor = driverActor(user.id);

    const updated = await drivers.updateLocation(actor, 24.7136, 46.6753);
    expect(updated.currentLatitude?.toString()).toContain('24.7136');
    expect(updated.currentLongitude?.toString()).toContain('46.6753');
    expect(updated.lastLocationAt).toBeTruthy();
  });

  it('has no self-service profile for a user with none provisioned', async () => {
    const user = await createDriverUser();

    await expect(drivers.getOwnProfile(driverActor(user.id))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // --- Staff management ---------------------------------------------------------

  it('deactivating a driver pulls them off shift', async () => {
    const user = await createDriverUser();
    const driver = await drivers.createProfile(ownerActor(ownerUserId), {
      userId: user.id,
      vehicleType: VehicleType.MOTORCYCLE,
    });
    await drivers.setOnlineStatus(driverActor(user.id), true);

    const deactivated = await drivers.deactivate(ownerActor(ownerUserId), driver.id);
    expect(deactivated.isOnline).toBe(false);
    expect(deactivated.isAvailable).toBe(false);

    await expect(drivers.getForStaff(ownerActor(ownerUserId), driver.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('filters the staff listing by online and availability', async () => {
    const onlineUser = await createDriverUser();
    await drivers.createProfile(ownerActor(ownerUserId), {
      userId: onlineUser.id,
      vehicleType: VehicleType.CAR,
    });
    await drivers.setOnlineStatus(driverActor(onlineUser.id), true);

    const offlineUser = await createDriverUser();
    await drivers.createProfile(ownerActor(ownerUserId), {
      userId: offlineUser.id,
      vehicleType: VehicleType.CAR,
    });

    const { data } = await drivers.listForStaff(ownerActor(ownerUserId), {
      page: 1,
      limit: 100,
      isOnline: true,
      skip: 0,
    });

    const ids = data.map((d) => d.userId);
    expect(ids).toContain(onlineUser.id);
    expect(ids).not.toContain(offlineUser.id);
  });

  // --- Branch isolation ------------------------------------------------------

  describe('branch isolation', () => {
    function branchActor(branchIds: string[]): Actor {
      return {
        kind: ActorKind.Staff,
        id: ownerUserId,
        email: 'branch@test',
        fullName: 'Branch Admin',
        roles: ['BRANCH_ADMIN'],
        permissions: new Set(['drivers:read', 'drivers:write']),
        branchScope: { kind: 'ASSIGNED', branchIds },
      };
    }

    it('does not show one branch the drivers of another', async () => {
      // This listing carries name, email, licence number, vehicle plate and
      // live GPS coordinates. It used to return the whole organisation's fleet
      // to any branch admin.
      const user = await createDriverUser();
      const grant = await prisma.userRole.findFirstOrThrow({
        where: { userId: user.id, branchId: { not: null } },
      });
      await drivers.createProfile(ownerActor(ownerUserId), {
        userId: user.id,
        vehicleType: VehicleType.CAR,
      });

      const otherBranch = await createBranch(prisma);
      const seen = await drivers.listForStaff(branchActor([otherBranch.id]), {
        skip: 0,
        limit: 50,
        page: 1,
      });

      expect(seen.data.some((d) => d.userId === user.id)).toBe(false);

      // Their own branch does see them.
      const own = await drivers.listForStaff(branchActor([grant.branchId as string]), {
        skip: 0,
        limit: 50,
        page: 1,
      });
      expect(own.data.some((d) => d.userId === user.id)).toBe(true);
    });

    it('inherits the branch from the driver’s role grant', async () => {
      const user = await createDriverUser();
      const grant = await prisma.userRole.findFirstOrThrow({
        where: { userId: user.id, branchId: { not: null } },
      });

      const created = await drivers.createProfile(ownerActor(ownerUserId), {
        userId: user.id,
        vehicleType: VehicleType.CAR,
      });

      const row = await prisma.driver.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.branchId).toBe(grant.branchId);
    });

    it('returns 404, not 403, for another branch’s driver', async () => {
      // Same 404 as a driver that does not exist, so ids cannot be probed —
      // the discipline the order and delivery lookups already follow.
      const user = await createDriverUser();
      const created = await drivers.createProfile(ownerActor(ownerUserId), {
        userId: user.id,
        vehicleType: VehicleType.CAR,
      });
      const otherBranch = await createBranch(prisma);

      await expect(
        drivers.getForStaff(branchActor([otherBranch.id]), created.id),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
