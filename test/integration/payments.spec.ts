import { randomUUID } from 'node:crypto';

import {
  ConflictException,
  ForbiddenException,
  INestApplication,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PrismaClient,
  WebhookProcessingStatus,
} from '@prisma/client';

import { ActorKind, type Actor } from '../../src/auth/types/actor';
import { AppConfigModule } from '../../src/config/config.module';
import { AppConfigService } from '../../src/config/app-config.service';
import { MenuModule } from '../../src/menu/menu.module';
import { OrdersModule } from '../../src/orders/orders.module';
import { OrdersService } from '../../src/orders/orders.service';
import { MockPaymentGateway } from '../../src/payments/gateway/mock-payment.gateway';
import { PAYMENT_GATEWAY } from '../../src/payments/gateway/payment-gateway.interface';
import { PaymentsModule } from '../../src/payments/payments.module';
import { PaymentsService } from '../../src/payments/payments.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { VatModule } from '../../src/vat/vat.module';
import { createBranch, createCategory, createCustomer, createProduct } from './helpers/factories';

/**
 * Payments (Phase 11) against a real database.
 *
 * The properties proven here are the load-bearing money rules: a client cannot
 * mark an order paid, only a signature-verified webhook advances it, and every
 * financial operation is idempotent.
 */
describe('PaymentsService (integration)', () => {
  const prisma = new PrismaClient();
  let orders: OrdersService;
  let payments: PaymentsService;
  let gateway: MockPaymentGateway;
  let app: INestApplication;
  let close: () => Promise<void>;

  beforeAll(async () => {
    await prisma.$connect();

    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, PrismaModule, VatModule, MenuModule, OrdersModule, PaymentsModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    orders = app.get(OrdersService);
    payments = app.get(PaymentsService);
    gateway = app.get(PAYMENT_GATEWAY);
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

  async function scene(cod = false) {
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
    const product = await createProduct(prisma, category.id, { basePriceMinor: 11_500 });
    await prisma.productAvailability.create({
      data: { productId: product.id, branchId: branch.id, isAvailable: true },
    });
    const customer = await createCustomer(prisma);
    return { branch, product, customer };
  }

  async function placeOnlineOrder(branchId: string, productId: string, customerId: string) {
    return orders.placeOrder(customerActor(customerId), {
      branchId,
      type: 'PICKUP',
      paymentMethod: PaymentMethod.CARD,
      items: [{ productId, quantity: 1 }],
    });
  }

  // --- Initiation ------------------------------------------------------------

  it('initiates a charge without marking anything paid', async () => {
    const { branch, product, customer } = await scene();
    const order = await placeOnlineOrder(branch.id, product.id, customer.id);

    const { payment, clientAction } = await payments.initiate(
      customerActor(customer.id),
      order.id,
      {
        method: PaymentMethod.CARD,
      },
    );

    expect(payment.status).toBe(PaymentStatus.PENDING);
    expect(payment.gatewayName).toBe('mock');
    expect(clientAction?.type).toBe('redirect');

    // The order has NOT advanced — initiating is not paying.
    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(reloaded.paymentStatus).toBe(PaymentStatus.PENDING);
  });

  it('settles its own charge when the sandbox is told to, and only then', async () => {
    // The demo has no bank and no hosted page, so nothing would ever deliver
    // the webhook that completes an online payment: every order would sit in
    // PENDING_PAYMENT for ever, invisible to the branch. With
    // PAYMENT_MOCK_AUTO_SETTLE on, the *server* delivers the mock gateway's own
    // signed success webhook through the ordinary ingestion path — the client
    // still proves nothing, which is the rule that matters.
    const { branch, product, customer } = await scene();
    const order = await placeOnlineOrder(branch.id, product.id, customer.id);

    const config = app.get(AppConfigService);
    const spy = jest
      .spyOn(config, 'payments', 'get')
      .mockReturnValue({ ...config.payments, mockAutoSettle: true });

    let paymentId: string;
    try {
      const { payment } = await payments.initiate(customerActor(customer.id), order.id, {
        method: PaymentMethod.CARD,
      });

      expect(payment.status).toBe(PaymentStatus.PAID);
      paymentId = payment.id;
    } finally {
      spy.mockRestore();
    }

    // The order followed the money, through the same transition choke point a
    // real gateway's webhook would have used.
    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.paymentStatus).toBe(PaymentStatus.PAID);
    expect(reloaded.status).toBe(OrderStatus.CONFIRMED);

    // And it took a genuine, signature-verified webhook to do it.
    const events = await prisma.paymentWebhookEvent.findMany({
      where: { paymentId },
    });
    expect(events).toHaveLength(1);
    expect(events[0].signatureVerified).toBe(true);
  });

  it('is idempotent per idempotency key — a replay charges once', async () => {
    const { branch, product, customer } = await scene();
    const order = await placeOnlineOrder(branch.id, product.id, customer.id);

    // Unique per run — the key is a global unique and the test DB is not reset
    // between runs, so a hard-coded key would collide with a prior run's attempt.
    const idempotencyKey = `idem-${randomUUID()}`;

    const first = await payments.initiate(customerActor(customer.id), order.id, {
      method: PaymentMethod.CARD,
      idempotencyKey,
    });
    const second = await payments.initiate(customerActor(customer.id), order.id, {
      method: PaymentMethod.CARD,
      idempotencyKey,
    });

    expect(second.replayed).toBe(true);
    expect(second.payment.id).toBe(first.payment.id);
    expect(await prisma.paymentAttempt.count({ where: { paymentId: first.payment.id } })).toBe(1);
  });

  it('refuses to pay a cash-on-delivery order online', async () => {
    const { branch, product, customer } = await scene(true);
    const order = await orders.placeOrder(customerActor(customer.id), {
      branchId: branch.id,
      type: 'PICKUP',
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      items: [{ productId: product.id, quantity: 1 }],
    });

    // A COD order is already CONFIRMED, so it is not awaiting online payment.
    await expect(
      payments.initiate(customerActor(customer.id), order.id, { method: PaymentMethod.CARD }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses a non-customer initiating payment', async () => {
    const { branch, product, customer } = await scene();
    const order = await placeOnlineOrder(branch.id, product.id, customer.id);
    const staff: Actor = {
      kind: ActorKind.Staff,
      id: 'u',
      email: 'e',
      fullName: 'f',
      roles: [],
      permissions: new Set(),
      branchScope: { kind: 'ALL' },
    };

    await expect(payments.initiate(staff, order.id, {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  // --- Verified webhook advances the order -----------------------------------

  it('marks paid and confirms the order only on a verified success webhook', async () => {
    const { branch, product, customer } = await scene();
    const order = await placeOnlineOrder(branch.id, product.id, customer.id);
    const { payment } = await payments.initiate(customerActor(customer.id), order.id, {
      method: PaymentMethod.CARD,
    });

    const gatewayPaymentId = (
      await prisma.payment.findUniqueOrThrow({
        where: { id: payment.id },
        select: { gatewayPaymentId: true },
      })
    ).gatewayPaymentId!;

    const result = await payments.simulateWebhook(gatewayPaymentId, 'SUCCEEDED');
    expect(result.status).toBe('processed');

    const paidOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(paidOrder.paymentStatus).toBe(PaymentStatus.PAID);
    expect(paidOrder.status).toBe(OrderStatus.CONFIRMED);

    const paidPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(paidPayment.status).toBe(PaymentStatus.PAID);
    expect(paidPayment.capturedAmountMinor).toBe(order.totalMinor);
    expect(paidPayment.capturedAt).not.toBeNull();

    // The order's history records the system-driven confirmation.
    const history = await prisma.orderStatusHistory.findMany({ where: { orderId: order.id } });
    expect(history.some((h) => h.toStatus === OrderStatus.CONFIRMED)).toBe(true);
  });

  it('fails the payment and the order on a verified failure webhook', async () => {
    const { branch, product, customer } = await scene();
    const order = await placeOnlineOrder(branch.id, product.id, customer.id);
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

    const failedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(failedOrder.paymentStatus).toBe(PaymentStatus.FAILED);
    expect(failedOrder.status).toBe(OrderStatus.PAYMENT_FAILED);
  });

  // --- Idempotent and signed webhooks ----------------------------------------

  it('processes a replayed webhook exactly once', async () => {
    const { branch, product, customer } = await scene();
    const order = await placeOnlineOrder(branch.id, product.id, customer.id);
    const { payment } = await payments.initiate(customerActor(customer.id), order.id, {
      method: PaymentMethod.CARD,
    });
    const gatewayPaymentId = (
      await prisma.payment.findUniqueOrThrow({
        where: { id: payment.id },
        select: { gatewayPaymentId: true },
      })
    ).gatewayPaymentId!;

    // One signed event, delivered twice.
    const { rawBody, signature } = gateway.buildWebhook({
      gatewayPaymentId,
      status: 'SUCCEEDED',
      amountMinor: order.totalMinor,
    });

    const first = await payments.handleWebhook('mock', rawBody, signature);
    const second = await payments.handleWebhook('mock', rawBody, signature);

    expect(first.status).toBe('processed');
    expect(second.status).toBe('duplicate');
    expect(
      await prisma.paymentWebhookEvent.count({ where: { gatewayName: 'mock' } }),
    ).toBeGreaterThanOrEqual(1);
  });

  it('rejects and records an unverified webhook, and never acts on it', async () => {
    const { branch, product, customer } = await scene();
    const order = await placeOnlineOrder(branch.id, product.id, customer.id);
    const { payment } = await payments.initiate(customerActor(customer.id), order.id, {
      method: PaymentMethod.CARD,
    });
    const gatewayPaymentId = (
      await prisma.payment.findUniqueOrThrow({
        where: { id: payment.id },
        select: { gatewayPaymentId: true },
      })
    ).gatewayPaymentId!;

    const { rawBody } = gateway.buildWebhook({
      gatewayPaymentId,
      status: 'SUCCEEDED',
      amountMinor: order.totalMinor,
    });

    await expect(
      payments.handleWebhook('mock', rawBody, 'not-a-valid-signature'),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // The order did not advance, and the event is recorded as unverified.
    const stillPending = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(stillPending.status).toBe(OrderStatus.PENDING_PAYMENT);

    const recorded = await prisma.paymentWebhookEvent.findFirst({
      where: { gatewayName: 'mock', signatureVerified: false },
    });
    expect(recorded?.processingStatus).toBe(WebhookProcessingStatus.FAILED);
  });

  it('rejects a webhook for an unknown gateway', async () => {
    await expect(payments.handleWebhook('some-other-gateway', '{}', 'sig')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
