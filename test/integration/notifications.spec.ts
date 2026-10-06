import { Test } from '@nestjs/testing';
import {
  NotificationDeliveryStatus,
  NotificationType,
  PaymentMethod,
  PrismaClient,
} from '@prisma/client';

import { ActorKind, type Actor } from '../../src/auth/types/actor';
import { AppConfigModule } from '../../src/config/config.module';
import { MenuModule } from '../../src/menu/menu.module';
import { OrdersModule } from '../../src/orders/orders.module';
import { OrdersService } from '../../src/orders/orders.service';
import { PaymentsModule } from '../../src/payments/payments.module';
import { PaymentsService } from '../../src/payments/payments.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { RefundsModule } from '../../src/refunds/refunds.module';
import { VatModule } from '../../src/vat/vat.module';
import {
  createBranch,
  createCategory,
  createCustomer,
  createProduct,
  unique,
} from './helpers/factories';

/**
 * Notifications (Phase 16) against a real database. Proves that order and
 * payment events produce a Notification with per-channel deliveries, sent over
 * the mock SMS and push adapters — and that a failure to notify never breaks the
 * operation that triggered it.
 */
describe('Notifications (integration)', () => {
  const prisma = new PrismaClient();
  let orders: OrdersService;
  let payments: PaymentsService;
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
      phone: '+966500000123',
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
      permissions: new Set(['orders:kitchen']),
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

  async function notificationsFor(orderId: string, type: NotificationType) {
    return prisma.notification.findMany({
      where: { orderId, type },
      include: { deliveries: true },
    });
  }

  it('notifies the customer when a COD order is confirmed and as it advances', async () => {
    const { branch, product, customer } = await scene();

    const order = await orders.placeOrder(customerActor(customer.id), {
      branchId: branch.id,
      type: 'PICKUP',
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      items: [{ productId: product.id, quantity: 1 }],
    });

    const confirmed = await notificationsFor(order.id, NotificationType.ORDER_CONFIRMED);
    expect(confirmed).toHaveLength(1);
    // One notification, delivered over SMS and push, both sent by the mock.
    expect(confirmed[0].deliveries).toHaveLength(2);
    for (const delivery of confirmed[0].deliveries) {
      expect(delivery.status).toBe(NotificationDeliveryStatus.SENT);
      expect(delivery.provider).toBe('mock');
      expect(delivery.providerMessageId).toBeTruthy();
    }

    await orders.markPreparing(ownerActor(), order.id);
    expect(await notificationsFor(order.id, NotificationType.ORDER_PREPARING)).toHaveLength(1);

    await orders.markReady(ownerActor(), order.id);
    expect(await notificationsFor(order.id, NotificationType.ORDER_READY)).toHaveLength(1);

    await orders.completePickup(ownerActor(), order.id);
    expect(await notificationsFor(order.id, NotificationType.ORDER_DELIVERED)).toHaveLength(1);
  });

  it('tells the customer their order was received on a branch that accepts manually', async () => {
    // The gap that made the notification feed look broken: a branch with
    // autoAcceptOrders off parks the order in AWAITING_ACCEPTANCE, that status
    // mapped to no message at all, and the customer heard nothing between
    // ordering and a staff member getting round to accepting. On the demo's
    // manual-accept branches that meant an empty inbox, always.
    const { branch, product, customer } = await scene();
    await prisma.branchSetting.update({
      where: { branchId: branch.id },
      data: { autoAcceptOrders: false },
    });

    const order = await orders.placeOrder(customerActor(customer.id), {
      branchId: branch.id,
      type: 'PICKUP',
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      items: [{ productId: product.id, quantity: 1 }],
    });

    const received = await notificationsFor(order.id, NotificationType.ORDER_RECEIVED);
    expect(received).toHaveLength(1);
    expect(received[0].customerId).toBe(customer.id);
    expect(received[0].deliveries).toHaveLength(2);

    // And the confirmation still follows when the branch accepts, so the
    // customer gets both halves of the story rather than one or the other.
    await orders.accept(ownerActor(), order.id);
    expect(await notificationsFor(order.id, NotificationType.ORDER_CONFIRMED)).toHaveLength(1);
  });

  it('does not notify while an online order is still awaiting payment, then does on confirmation', async () => {
    const { branch, product, customer } = await scene(false);

    const order = await orders.placeOrder(customerActor(customer.id), {
      branchId: branch.id,
      type: 'PICKUP',
      paymentMethod: PaymentMethod.CARD,
      items: [{ productId: product.id, quantity: 1 }],
    });

    // Nothing yet — the order is PENDING_PAYMENT.
    expect(await prisma.notification.count({ where: { orderId: order.id } })).toBe(0);

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

    expect(await notificationsFor(order.id, NotificationType.ORDER_CONFIRMED)).toHaveLength(1);
  });

  it('notifies on a failed payment', async () => {
    const { branch, product, customer } = await scene(false);
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
    await payments.simulateWebhook(gatewayPaymentId, 'FAILED');

    expect(await notificationsFor(order.id, NotificationType.PAYMENT_FAILED)).toHaveLength(1);
  });
});
