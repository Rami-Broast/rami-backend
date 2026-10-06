import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PaymentMethod, PaymentStatus, PrismaClient, RefundStatus } from '@prisma/client';

import { ActorKind, type Actor } from '../../src/auth/types/actor';
import { AppConfigModule } from '../../src/config/config.module';
import { MenuModule } from '../../src/menu/menu.module';
import { OrdersModule } from '../../src/orders/orders.module';
import { OrdersService } from '../../src/orders/orders.service';
import { PaymentsModule } from '../../src/payments/payments.module';
import { PaymentsService } from '../../src/payments/payments.service';
import { RefundsModule } from '../../src/refunds/refunds.module';
import { RefundsService } from '../../src/refunds/refunds.service';
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
 * Refunds (Phase 12) against a real database. Proves the refund rules end to
 * end: never exceed refundable, idempotent, asynchronous completion, and branch
 * isolation — with the money landing on the payment and the order only when a
 * verified gateway event confirms it.
 */
describe('RefundsService (integration)', () => {
  const prisma = new PrismaClient();
  let orders: OrdersService;
  let payments: PaymentsService;
  let refunds: RefundsService;
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
      permissions: new Set(['refunds:read', 'refunds:write']),
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
      permissions: new Set(['refunds:read', 'refunds:write']),
      branchScope: { kind: 'ASSIGNED', branchIds },
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
    const product = await createProduct(prisma, category.id, { basePriceMinor: 10_000 });
    await prisma.productAvailability.create({
      data: { productId: product.id, branchId: branch.id, isAvailable: true },
    });
    const customer = await createCustomer(prisma);
    return { branch, product, customer };
  }

  /** Places an online order and drives it to PAID via a verified webhook. */
  async function paidOrder(branchId: string, productId: string, customerId: string) {
    const order = await orders.placeOrder(customerActor(customerId), {
      branchId,
      type: 'PICKUP',
      paymentMethod: PaymentMethod.CARD,
      items: [{ productId, quantity: 1 }],
    });
    const { payment } = await payments.initiate(customerActor(customerId), order.id, {
      method: PaymentMethod.CARD,
    });
    const gatewayPaymentId = (
      await prisma.payment.findUniqueOrThrow({
        where: { id: payment.id },
        select: { gatewayPaymentId: true },
      })
    ).gatewayPaymentId!;
    await payments.simulateWebhook(gatewayPaymentId, 'SUCCEEDED');
    return { orderId: order.id, paymentId: payment.id, totalMinor: order.totalMinor };
  }

  // --- Full lifecycle --------------------------------------------------------

  it('processes a partial then a final refund, never exceeding refundable', async () => {
    const { branch, product, customer } = await scene();
    const { orderId, paymentId, totalMinor } = await paidOrder(branch.id, product.id, customer.id);
    const half = Math.floor(totalMinor / 2);

    // Partial refund. Creating it is asynchronous: PROCESSING, order REFUND_PENDING.
    const partial = await refunds.createRefund(ownerActor(), {
      paymentId,
      amountMinor: half,
      reason: 'Missing item',
    });
    expect(partial.status).toBe(RefundStatus.PROCESSING);

    let order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    let payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(order.paymentStatus).toBe(PaymentStatus.REFUND_PENDING);
    expect(payment.status).toBe(PaymentStatus.PAID); // money not moved until confirmed
    expect(payment.refundedAmountMinor).toBe(0);

    // Gateway confirms the refund.
    await payments.simulateRefundWebhook(partial.gatewayRefundId!, 'SUCCEEDED');

    order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    const done = await prisma.refund.findUniqueOrThrow({ where: { id: partial.id } });
    expect(done.status).toBe(RefundStatus.COMPLETED);
    expect(payment.refundedAmountMinor).toBe(half);
    expect(payment.status).toBe(PaymentStatus.PARTIALLY_REFUNDED);
    expect(order.paymentStatus).toBe(PaymentStatus.PARTIALLY_REFUNDED);

    // Refund the remainder → fully refunded.
    const remainder = totalMinor - half;
    const final = await refunds.createRefund(ownerActor(), {
      paymentId,
      amountMinor: remainder,
      reason: 'Order cancelled',
    });
    await payments.simulateRefundWebhook(final.gatewayRefundId!, 'SUCCEEDED');

    payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(payment.refundedAmountMinor).toBe(totalMinor);
    expect(payment.status).toBe(PaymentStatus.REFUNDED);
    expect(order.paymentStatus).toBe(PaymentStatus.REFUNDED);
  });

  it('never refunds more than the remaining refundable amount', async () => {
    const { branch, product, customer } = await scene();
    const { paymentId, totalMinor } = await paidOrder(branch.id, product.id, customer.id);

    await expect(
      refunds.createRefund(ownerActor(), {
        paymentId,
        amountMinor: totalMinor + 1,
        reason: 'Too much',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('is idempotent per idempotency key', async () => {
    const { branch, product, customer } = await scene();
    const { paymentId } = await paidOrder(branch.id, product.id, customer.id);
    const key = `rf-${unique('key')}`;

    const first = await refunds.createRefund(ownerActor(), {
      paymentId,
      amountMinor: 1000,
      reason: 'A',
      idempotencyKey: key,
    });
    const second = await refunds.createRefund(ownerActor(), {
      paymentId,
      amountMinor: 1000,
      reason: 'A',
      idempotencyKey: key,
    });

    expect(second.id).toBe(first.id);
    expect(await prisma.refund.count({ where: { paymentId } })).toBe(1);
  });

  it('refuses to refund a payment that is not paid', async () => {
    const { branch, product, customer } = await scene();
    // Initiate but never confirm — payment stays PENDING.
    const order = await orders.placeOrder(customerActor(customer.id), {
      branchId: branch.id,
      type: 'PICKUP',
      paymentMethod: PaymentMethod.CARD,
      items: [{ productId: product.id, quantity: 1 }],
    });
    const { payment } = await payments.initiate(customerActor(customer.id), order.id, {
      method: PaymentMethod.CARD,
    });

    await expect(
      refunds.createRefund(ownerActor(), { paymentId: payment.id, reason: 'Nope' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses to refund a cash-on-delivery payment through the gateway', async () => {
    const { branch, product, customer } = await scene(true);
    const order = await orders.placeOrder(customerActor(customer.id), {
      branchId: branch.id,
      type: 'PICKUP',
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      items: [{ productId: product.id, quantity: 1 }],
    });
    const codPayment = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });

    await expect(
      refunds.createRefund(ownerActor(), { paymentId: codPayment.id, reason: 'Cash' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('isolates refunds to the staff member’s branches', async () => {
    const a = await scene();
    const { paymentId } = await paidOrder(a.branch.id, a.product.id, a.customer.id);
    const b = await scene();
    const staffOfB = branchStaffActor('rf-staff-b', [b.branch.id]);

    await expect(
      refunds.createRefund(staffOfB, { paymentId, amountMinor: 100, reason: 'X' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('restores the order money state when a refund fails at the gateway', async () => {
    const { branch, product, customer } = await scene();
    const { orderId, paymentId } = await paidOrder(branch.id, product.id, customer.id);

    const refund = await refunds.createRefund(ownerActor(), {
      paymentId,
      amountMinor: 1000,
      reason: 'Try',
    });
    await payments.simulateRefundWebhook(refund.gatewayRefundId!, 'FAILED');

    const failed = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(failed.status).toBe(RefundStatus.FAILED);
    expect(payment.refundedAmountMinor).toBe(0);
    // Order returns to PAID — no money actually moved.
    expect(order.paymentStatus).toBe(PaymentStatus.PAID);
  });
});
