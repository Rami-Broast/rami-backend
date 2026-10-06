import { Test } from '@nestjs/testing';
import { PaymentMethod, PrismaClient } from '@prisma/client';

import { ActorKind, type Actor } from '../../src/auth/types/actor';
import { AppConfigModule } from '../../src/config/config.module';
import { LoyaltyService } from '../../src/loyalty/loyalty.service';
import { MenuModule } from '../../src/menu/menu.module';
import { OrdersModule } from '../../src/orders/orders.module';
import { OrdersService } from '../../src/orders/orders.service';
import { PaymentsModule } from '../../src/payments/payments.module';
import { PaymentsService } from '../../src/payments/payments.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { RefundsModule } from '../../src/refunds/refunds.module';
import { RefundsService } from '../../src/refunds/refunds.service';
import { VatModule } from '../../src/vat/vat.module';
import {
  createBranch,
  createCategory,
  createCustomer,
  createProduct,
  unique,
} from './helpers/factories';

/**
 * Loyalty (Phase 17) against a real database. Proves the ledger behaviour:
 * points earned on delivery, reversed on cancellation, and reversed in
 * proportion to a refund — with the balance always the sum of the ledger.
 */
describe('Loyalty (integration)', () => {
  const prisma = new PrismaClient();
  let orders: OrdersService;
  let payments: PaymentsService;
  let refunds: RefundsService;
  let loyalty: LoyaltyService;
  let close: () => Promise<void>;
  let ownerUserId: string;

  beforeAll(async () => {
    await prisma.$connect();
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        PrismaModule,
        VatModule,
        MenuModule,
        OrdersModule,
        RefundsModule,
        PaymentsModule,
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    orders = app.get(OrdersService);
    payments = app.get(PaymentsService);
    refunds = app.get(RefundsService);
    loyalty = app.get(LoyaltyService);
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
      phone: '+966500009999',
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
      permissions: new Set(['orders:kitchen', 'orders:cancel', 'loyalty:adjust']),
      branchScope: { kind: 'ALL' },
    };
  }

  async function scene(cod = true) {
    const branch = await createBranch(prisma);
    await prisma.branchSetting.create({
      data: {
        branchId: branch.id,
        acceptsCashOnDelivery: cod,
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

  async function placeCod(branchId: string, productId: string, customerId: string) {
    return orders.placeOrder(customerActor(customerId), {
      branchId,
      type: 'PICKUP',
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      items: [{ productId, quantity: 1 }],
    });
  }

  it('earns points on delivery, once', async () => {
    const { branch, product, customer } = await scene();
    const order = await placeCod(branch.id, product.id, customer.id);

    // 10,000 halalas = 100.00 SAR → 100 points at the default rate.
    expect(await loyalty.balance(customer.id)).toBe(0); // not delivered yet

    await orders.markPreparing(ownerActor(), order.id);
    await orders.markReady(ownerActor(), order.id);
    await orders.completePickup(ownerActor(), order.id);

    expect(await loyalty.balance(customer.id)).toBe(100);

    // Re-running delivery-side earn is idempotent (no double-earn).
    await loyalty.earnForOrder(order.id);
    expect(await loyalty.balance(customer.id)).toBe(100);
  });

  it('reverses points when a delivered order is later cancelled', async () => {
    // Deliver, earn, then cancel via a direct reverse (cancellation after
    // delivery is an admin action; the reverse path is what we assert).
    const { branch, product, customer } = await scene();
    const order = await placeCod(branch.id, product.id, customer.id);
    await orders.markPreparing(ownerActor(), order.id);
    await orders.markReady(ownerActor(), order.id);
    await orders.completePickup(ownerActor(), order.id);
    expect(await loyalty.balance(customer.id)).toBe(100);

    await loyalty.reverseAllForOrder(order.id, 'Cancelled');
    expect(await loyalty.balance(customer.id)).toBe(0);

    // Idempotent — a second reverse does not double-subtract.
    await loyalty.reverseAllForOrder(order.id, 'Cancelled');
    expect(await loyalty.balance(customer.id)).toBe(0);
  });

  it('reverses points in proportion to a partial refund', async () => {
    const { branch, product, customer } = await scene(false);
    // Online order → pay → deliver → earn.
    const order = await orders.placeOrder(customerActor(customer.id), {
      branchId: branch.id,
      type: 'PICKUP',
      paymentMethod: PaymentMethod.CARD,
      items: [{ productId: product.id, quantity: 1 }],
    });
    const { payment } = await payments.initiate(customerActor(customer.id), order.id, {
      method: PaymentMethod.CARD,
    });
    const gatewayPaymentId = (
      await prisma.payment.findUniqueOrThrow({
        where: { id: payment.id },
        select: { gatewayPaymentId: true },
      })
    ).gatewayPaymentId!;
    await payments.simulateWebhook(gatewayPaymentId, 'SUCCEEDED');

    await orders.markPreparing(ownerActor(), order.id);
    await orders.markReady(ownerActor(), order.id);
    await orders.completePickup(ownerActor(), order.id);
    expect(await loyalty.balance(customer.id)).toBe(100);

    // Refund half → reverse half the points.
    const refund = await refunds.createRefund(ownerActor(), {
      paymentId: payment.id,
      amountMinor: 5000,
      reason: 'Half',
    });
    await payments.simulateRefundWebhook(refund.gatewayRefundId!, 'SUCCEEDED');
    expect(await loyalty.balance(customer.id)).toBe(50);

    // Refund the rest → reverse the remaining points, not more.
    const rest = await refunds.createRefund(ownerActor(), {
      paymentId: payment.id,
      amountMinor: 5000,
      reason: 'Rest',
    });
    await payments.simulateRefundWebhook(rest.gatewayRefundId!, 'SUCCEEDED');
    expect(await loyalty.balance(customer.id)).toBe(0);
  });

  it('records a manual staff adjustment as a signed ledger entry', async () => {
    const { customer } = await scene();
    await loyalty.adjust(ownerActor(), customer.id, 250, 'Goodwill');
    expect(await loyalty.balance(customer.id)).toBe(250);
    await loyalty.adjust(ownerActor(), customer.id, -100, 'Correction');
    expect(await loyalty.balance(customer.id)).toBe(150);

    const ledger = await loyalty.ledger(customer.id, { page: 1, limit: 25, skip: 0 });
    expect(ledger.balance).toBe(150);
    expect(ledger.data.length).toBe(2);
  });
});
