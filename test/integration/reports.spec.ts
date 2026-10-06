import { Test } from '@nestjs/testing';
import { OrderStatus, PaymentMethod, PrismaClient } from '@prisma/client';

import { ActorKind, type Actor } from '../../src/auth/types/actor';
import { AppConfigModule } from '../../src/config/config.module';
import { MenuModule } from '../../src/menu/menu.module';
import { OrdersModule } from '../../src/orders/orders.module';
import { OrdersService } from '../../src/orders/orders.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { ReportsModule } from '../../src/reports/reports.module';
import { ReportsService } from '../../src/reports/reports.service';
import { VatModule } from '../../src/vat/vat.module';
import {
  createBranch,
  createCategory,
  createCustomer,
  createProduct,
  unique,
} from './helpers/factories';

/**
 * Reports (Phase 18) against a real database.
 *
 * Proves the reports read snapshotted figures, count only realised sales,
 * group VAT by the snapshotted rate, and stay branch-isolated.
 */
describe('ReportsService (integration)', () => {
  const prisma = new PrismaClient();
  let orders: OrdersService;
  let reports: ReportsService;
  let close: () => Promise<void>;
  let ownerUserId: string;

  beforeAll(async () => {
    await prisma.$connect();

    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, PrismaModule, VatModule, MenuModule, OrdersModule, ReportsModule],
    }).compile();

    const app = moduleRef.createNestApplication();
    await app.init();

    orders = app.get(OrdersService);
    reports = app.get(ReportsService);
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
      permissions: new Set(['reports:read']),
      branchScope: { kind: 'ALL' },
    };
  }

  function branchStaffActor(branchIds: string[]): Actor {
    return {
      kind: ActorKind.Staff,
      id: `bs-${unique('u')}`,
      email: 'bs@test',
      fullName: 'Branch Staff',
      roles: ['BRANCH_ADMIN'],
      permissions: new Set(['reports:read']),
      branchScope: { kind: 'ASSIGNED', branchIds },
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
    const product = await createProduct(prisma, category.id, { basePriceMinor: 11_500 });
    await prisma.productAvailability.create({
      data: { productId: product.id, branchId: branch.id, isAvailable: true },
    });
    const customer = await createCustomer(prisma);
    return { branch, product, customer };
  }

  /** A confirmed COD order (a realised sale). */
  async function codOrder(branchId: string, productId: string, customerId: string, qty = 1) {
    return orders.placeOrder(customerActor(customerId), {
      branchId,
      type: 'PICKUP',
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      items: [{ productId, quantity: qty }],
    });
  }

  const window = () => ({
    from: new Date(Date.now() - 3600_000).toISOString(),
    to: new Date(Date.now() + 3600_000).toISOString(),
  });

  // --- Sales -----------------------------------------------------------------

  it('counts realised sales and excludes cancelled orders from revenue', async () => {
    const { branch, product, customer } = await scene();
    await codOrder(branch.id, product.id, customer.id); // CONFIRMED — realised
    const toCancel = await codOrder(branch.id, product.id, customer.id);
    await orders.cancelByStaff(
      { ...ownerActor(), permissions: new Set(['orders:cancel']) },
      toCancel.id,
      { reason: 'Test' },
    );

    const report = await reports.salesReport(ownerActor(), { ...window(), branchId: branch.id });

    // One realised order at 11,500; the cancelled one is excluded from revenue.
    expect(report.realised.orders).toBe(1);
    expect(report.realised.totalMinor).toBe(11_500);
    expect(report.realised.vatMinor).toBe(1500); // 15% of 10,000 taxable base
    expect(report.realised.taxableBaseMinor).toBe(10_000);

    const cancelled = report.statusBreakdown.find((r) => r.status === OrderStatus.CANCELLED);
    expect(cancelled?.orders).toBe(1);
  });

  it('reads snapshotted totals, unaffected by a later menu price change', async () => {
    const { branch, product, customer } = await scene();
    await codOrder(branch.id, product.id, customer.id);

    await prisma.product.update({ where: { id: product.id }, data: { basePriceMinor: 99_999 } });

    const report = await reports.salesReport(ownerActor(), { ...window(), branchId: branch.id });
    expect(report.realised.totalMinor).toBe(11_500);
  });

  // --- VAT -------------------------------------------------------------------

  it('groups VAT by the rate snapshotted on the order', async () => {
    const { branch, product, customer } = await scene();
    await codOrder(branch.id, product.id, customer.id, 2);

    const report = await reports.vatReport(ownerActor(), { ...window(), branchId: branch.id });

    expect(report.basis).toBe('gross');
    expect(report.byRate).toHaveLength(1);
    expect(report.byRate[0].vatRate).toBe('0.15');
    expect(report.totalVatMinor).toBe(3000); // 15% of 20,000 taxable base
  });

  // --- Payments --------------------------------------------------------------

  it('summarises payments by status and method', async () => {
    const { branch, product, customer } = await scene();
    await codOrder(branch.id, product.id, customer.id);

    const report = await reports.paymentsReport(ownerActor(), { ...window(), branchId: branch.id });

    // The COD order created a pending cash payment.
    const cod = report.byMethod.find((r) => r.method === PaymentMethod.CASH_ON_DELIVERY);
    expect(cod?.payments).toBe(1);
    expect(report.totals.payments).toBeGreaterThanOrEqual(1);
  });

  // --- Isolation -------------------------------------------------------------

  it('isolates a branch admin’s report to their own branch', async () => {
    const a = await scene();
    const b = await scene();
    await codOrder(a.branch.id, a.product.id, a.customer.id);
    await codOrder(b.branch.id, b.product.id, b.customer.id);

    // Branch staff of A, naming no branch, see only A.
    const report = await reports.salesReport(branchStaffActor([a.branch.id]), window());
    expect(report.realised.orders).toBe(1);
    expect(report.realised.totalMinor).toBe(11_500);
  });
});
