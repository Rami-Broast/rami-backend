import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PrismaClient,
  RefundRequestStatus,
  RefundRequestType,
  RefundStatus,
} from '@prisma/client';

import { ActorKind, type Actor } from '../../src/auth/types/actor';
import { AppConfigModule } from '../../src/config/config.module';
import { MenuModule } from '../../src/menu/menu.module';
import { OrdersModule } from '../../src/orders/orders.module';
import { OrdersService } from '../../src/orders/orders.service';
import { PaymentsModule } from '../../src/payments/payments.module';
import { PaymentsService } from '../../src/payments/payments.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { RefundRequestsService } from '../../src/refunds/refund-requests.service';
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
 * Customer refund and cancellation requests against a real database.
 *
 * The shape being proved is the owner's: the **customer** asks, the **branch**
 * decides, and the **owner** pays out by hand in the gateway's dashboard and
 * records it. So the cases that matter are the ones where those come apart — an
 * approval that promises money and moves none, a payout recorded afterwards, and
 * the states in between where the order must not read as refunded.
 */
describe('RefundRequestsService (integration)', () => {
  const prisma = new PrismaClient();
  let orders: OrdersService;
  let payments: PaymentsService;
  let requests: RefundRequestsService;
  let close: () => Promise<void>;
  let ownerUserId: string;
  let branchUserId: string;

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
    requests = app.get(RefundRequestsService);
    close = () => app.close();

    const owner = await prisma.user.create({
      data: { email: `${unique('owner')}@test`, fullName: 'Owner', passwordHash: 'x' },
    });
    ownerUserId = owner.id;

    const manager = await prisma.user.create({
      data: { email: `${unique('branch')}@test`, fullName: 'Branch Manager', passwordHash: 'x' },
    });
    branchUserId = manager.id;
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
      permissions: new Set(['refunds:read', 'refunds:write', 'orders:cancel']),
      branchScope: { kind: 'ALL' },
    };
  }

  /**
   * A branch manager: may decide a request, may **not** move money.
   *
   * Branch scope is left wide here because each test builds its own branch and
   * isolation is proved by its own test below; what this actor exists to carry
   * is the permission split — `refund-requests:decide` without `refunds:write`.
   * (The guards enforce that at the HTTP layer, which the e2e write contracts
   * cover; this actor keeps the service tests honest about who does what.)
   */
  function branchActor(): Actor {
    return {
      kind: ActorKind.Staff,
      id: branchUserId,
      email: 'branch@test',
      fullName: 'Branch Manager',
      roles: ['BRANCH_ADMIN'],
      permissions: new Set(['refunds:read', 'refund-requests:decide', 'orders:cancel']),
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
      permissions: new Set(['refunds:read', 'refunds:write', 'orders:cancel']),
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

  /** Walks a paid pickup order to a status a customer can no longer cancel from. */
  async function advance(orderId: string, to: OrderStatus) {
    const staff = ownerActor();
    await orders.markPreparing(staff, orderId);
    if (to === OrderStatus.PREPARING) return;
    await orders.markReady(staff, orderId);
    if (to === OrderStatus.READY) return;
    await orders.completePickup(staff, orderId);
  }

  // --- Eligibility -----------------------------------------------------------

  it('lets an unpaid order be cancelled outright, with no request and no queue', async () => {
    // Cash on delivery: nothing has been captured, so dropping the order costs
    // the branch nothing and needs nobody's approval.
    const { branch, product, customer } = await scene(true);
    const order = await orders.placeOrder(customerActor(customer.id), {
      branchId: branch.id,
      type: 'PICKUP',
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      items: [{ productId: product.id, quantity: 1 }],
    });

    const eligibility = await requests.eligibilityForCustomer(customerActor(customer.id), order.id);
    expect(eligibility.canSelfCancel).toBe(true);
    expect(eligibility.canRequest).toBe(false);

    // …and raising a request instead is refused, because there is nothing for
    // the branch to decide.
    await expect(
      requests.createForCustomer(customerActor(customer.id), order.id, {
        reason: 'Changed my mind',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    const cancelled = await orders.cancelByCustomer(customerActor(customer.id), order.id, {
      reason: 'Changed my mind',
    });
    expect(cancelled.status).toBe(OrderStatus.CANCELLED);
  });

  it('refuses to let a paid order be cancelled outright, however early', async () => {
    // Owner decision (2026-09-08): money is the gate, not time. Once a payment
    // is captured, cancelling means giving money back — the branch's call.
    const { branch, product, customer } = await scene();
    const { orderId } = await paidOrder(branch.id, product.id, customer.id);

    const eligibility = await requests.eligibilityForCustomer(customerActor(customer.id), orderId);
    expect(eligibility.canSelfCancel).toBe(false);
    expect(eligibility.canRequest).toBe(true);

    // Enforced on the server, not just withheld from the screen: a client that
    // skipped the eligibility read, or held a stale one, is still refused.
    await expect(
      orders.cancelByCustomer(customerActor(customer.id), orderId, { reason: 'Changed my mind' }),
    ).rejects.toBeInstanceOf(ConflictException);

    // The request is the route that remains open.
    const raised = await requests.createForCustomer(customerActor(customer.id), orderId, {
      reason: 'Changed my mind',
    });
    expect(raised.type).toBe(RefundRequestType.CANCELLATION);
    expect(raised.status).toBe(RefundRequestStatus.PENDING);
  });

  it('does not let one customer see or ask about another customer’s order', async () => {
    const { branch, product, customer } = await scene();
    const { orderId } = await paidOrder(branch.id, product.id, customer.id);
    const stranger = await createCustomer(prisma);

    // The same "not found" as an order that does not exist, so an id cannot be
    // probed by watching the error change.
    await expect(
      requests.eligibilityForCustomer(customerActor(stranger.id), orderId),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // --- Cancellation request --------------------------------------------------

  it('approves a cancellation: the order stops, the money waits for the owner', async () => {
    const { branch, product, customer } = await scene();
    const { orderId, paymentId, totalMinor } = await paidOrder(branch.id, product.id, customer.id);
    await advance(orderId, OrderStatus.PREPARING);

    const request = await requests.createForCustomer(customerActor(customer.id), orderId, {
      reason: 'Ordered the wrong branch',
    });
    expect(request.type).toBe(RefundRequestType.CANCELLATION);
    expect(request.status).toBe(RefundRequestStatus.PENDING);

    const { request: approved, outcome } = await requests.approve(branchActor(), request.id, {
      note: 'Sorry about that.',
    });

    // Approving stops the order and promises the money. It does not send it —
    // the owner does that in the gateway's own dashboard.
    expect(outcome).toBe('AWAITING_PAYOUT');
    expect(approved.status).toBe(RefundRequestStatus.APPROVED);
    expect(approved.orderCancelled).toBe(true);
    expect(approved.approvedAmountMinor).toBe(totalMinor);
    expect(approved.refundId).toBeNull();
    expect(approved.refundIssuedAt).toBeNull();

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.CANCELLED);
    // Crucially still PAID: nothing has gone back yet, and a screen reading this
    // column must not tell a customer their money is on its way.
    expect(order.paymentStatus).toBe(PaymentStatus.PAID);
    expect(await prisma.refund.count({ where: { orderId } })).toBe(0);

    // The owner refunds in Tap, then records it here.
    const recorded = await requests.recordRefundIssued(ownerActor(), request.id, {
      gatewayReference: 'tap_ref_12345',
    });

    expect(recorded.refundIssuedAt).not.toBeNull();
    const refund = await prisma.refund.findUniqueOrThrow({ where: { id: recorded.refundId! } });
    expect(refund.paymentId).toBe(paymentId);
    expect(refund.amountMinor).toBe(totalMinor);
    // Already done in the dashboard: there is no PROCESSING state to pass
    // through, and no webhook will ever arrive to confirm it.
    expect(refund.status).toBe(RefundStatus.COMPLETED);
    expect(refund.issuedManually).toBe(true);
    expect(refund.gatewayReference).toBe('tap_ref_12345');
    expect(refund.gatewayRefundId).toBeNull();

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.status).toBe(PaymentStatus.REFUNDED);
    expect(payment.refundedAmountMinor).toBe(totalMinor);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus).toBe(
      PaymentStatus.REFUNDED,
    );
  });

  it('refunds a delivered order without touching fulfilment, once the owner pays out', async () => {
    const { branch, product, customer } = await scene();
    const { orderId, paymentId, totalMinor } = await paidOrder(branch.id, product.id, customer.id);
    await advance(orderId, OrderStatus.DELIVERED);

    const request = await requests.createForCustomer(customerActor(customer.id), orderId, {
      reason: 'The food was cold',
    });
    expect(request.type).toBe(RefundRequestType.REFUND);

    const half = Math.floor(totalMinor / 2);
    const { request: approved, outcome } = await requests.approve(branchActor(), request.id, {
      amountMinor: half,
    });

    expect(outcome).toBe('AWAITING_PAYOUT');
    expect(approved.approvedAmountMinor).toBe(half);
    // A delivered order cannot legally be cancelled, and a refund never moves
    // fulfilment on its own.
    expect(approved.orderCancelled).toBe(false);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.DELIVERED);

    // The owner pays out the amount the branch agreed, without restating it.
    const recorded = await requests.recordRefundIssued(ownerActor(), request.id, {
      gatewayReference: 'tap_ref_partial',
    });
    const refund = await prisma.refund.findUniqueOrThrow({ where: { id: recorded.refundId! } });
    expect(refund.amountMinor).toBe(half);

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.status).toBe(PaymentStatus.PARTIALLY_REFUNDED);
    expect(payment.refundedAmountMinor).toBe(half);
  });

  it('approves a cash-on-delivery cancellation as a manual settlement, with no refund row', async () => {
    const { branch, product, customer } = await scene(true);
    const order = await orders.placeOrder(customerActor(customer.id), {
      branchId: branch.id,
      type: 'PICKUP',
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      items: [{ productId: product.id, quantity: 1 }],
    });
    await advance(order.id, OrderStatus.PREPARING);

    const request = await requests.createForCustomer(customerActor(customer.id), order.id, {
      reason: 'Cannot collect it',
    });

    const { request: approved, outcome } = await requests.approve(branchActor(), request.id, {});

    // Nothing was ever captured, so nothing goes back — and no `Refund` row is
    // written, because a refund row for money nobody moved would be a lie.
    expect(outcome).toBe('CANCELLED_NO_REFUND');
    expect(approved.refundId).toBeNull();
    expect(approved.orderCancelled).toBe(true);
    const stored = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.status).toBe(OrderStatus.CANCELLED);
  });

  // --- Measuring the policy --------------------------------------------------

  it('records a customer the window turned away, once, with how late they were', async () => {
    // The whole point: a refused customer leaves no request, no refund and no
    // order change. Without this row a window that is too short is invisible.
    const { branch, product, customer } = await scene();
    const { orderId } = await paidOrder(branch.id, product.id, customer.id);
    await advance(orderId, OrderStatus.PREPARING);

    // 40 minutes past a 10-minute window.
    await prisma.order.update({
      where: { id: orderId },
      data: { placedAt: new Date(Date.now() - 50 * 60 * 1000) },
    });

    const eligibility = await requests.eligibilityForCustomer(customerActor(customer.id), orderId);
    expect(eligibility.blocker).toBe('WINDOW_CLOSED');
    // The type survives the refusal — which window was missed is the content.
    expect(eligibility.type).toBe(RefundRequestType.CANCELLATION);

    const miss = await prisma.refundWindowMiss.findUniqueOrThrow({ where: { orderId } });
    expect(miss.type).toBe(RefundRequestType.CANCELLATION);
    expect(miss.minutesLate).toBeGreaterThanOrEqual(39);
    expect(miss.windowMinutes).toBe(10);

    // Re-opening the order screen must not read as another turned-away
    // customer — otherwise the table measures refreshing, not refusing.
    await requests.eligibilityForCustomer(customerActor(customer.id), orderId);
    await requests.eligibilityForCustomer(customerActor(customer.id), orderId);
    expect(await prisma.refundWindowMiss.count({ where: { orderId } })).toBe(1);
  });

  it('records nothing for a customer who was inside the window', async () => {
    const { branch, product, customer } = await scene();
    const { orderId } = await paidOrder(branch.id, product.id, customer.id);
    await advance(orderId, OrderStatus.PREPARING);

    await requests.eligibilityForCustomer(customerActor(customer.id), orderId);

    expect(await prisma.refundWindowMiss.count({ where: { orderId } })).toBe(0);
  });

  // --- Guards ----------------------------------------------------------------

  it('allows only one open request per order', async () => {
    const { branch, product, customer } = await scene();
    const { orderId } = await paidOrder(branch.id, product.id, customer.id);
    await advance(orderId, OrderStatus.PREPARING);

    const first = await requests.createForCustomer(customerActor(customer.id), orderId, {
      reason: 'One',
    });
    await expect(
      requests.createForCustomer(customerActor(customer.id), orderId, { reason: 'Two' }),
    ).rejects.toBeInstanceOf(ConflictException);

    // Two simultaneous submissions cannot both land either — the partial unique
    // index is the guard, and the loser is handed the winner's request.
    const withdrawn = await requests.withdrawForCustomer(customerActor(customer.id), first.id);
    expect(withdrawn.status).toBe(RefundRequestStatus.WITHDRAWN);

    const [a, b] = await Promise.all([
      requests.createForCustomer(customerActor(customer.id), orderId, { reason: 'Race A' }),
      requests.createForCustomer(customerActor(customer.id), orderId, { reason: 'Race B' }),
    ]);
    expect(a.id).toBe(b.id);
    expect(
      await prisma.refundRequest.count({
        where: { orderId, status: RefundRequestStatus.PENDING },
      }),
    ).toBe(1);
  });

  it('cannot be decided twice', async () => {
    const { branch, product, customer } = await scene();
    const { orderId } = await paidOrder(branch.id, product.id, customer.id);
    await advance(orderId, OrderStatus.DELIVERED);

    const request = await requests.createForCustomer(customerActor(customer.id), orderId, {
      reason: 'Missing item',
    });
    await requests.approve(branchActor(), request.id, {});

    await expect(requests.approve(branchActor(), request.id, {})).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('cannot record the same payout twice, so money cannot leave twice', async () => {
    const { branch, product, customer } = await scene();
    const { orderId } = await paidOrder(branch.id, product.id, customer.id);
    await advance(orderId, OrderStatus.DELIVERED);

    const request = await requests.createForCustomer(customerActor(customer.id), orderId, {
      reason: 'Missing item',
    });
    await requests.approve(branchActor(), request.id, {});
    await requests.recordRefundIssued(ownerActor(), request.id, { gatewayReference: 'tap_1' });

    // The second press is the dangerous one: the owner has already paid out in
    // the dashboard, and a second `Refund` row would double the refund in every
    // report and in reconciliation.
    await expect(
      requests.recordRefundIssued(ownerActor(), request.id, { gatewayReference: 'tap_2' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await prisma.refund.count({ where: { orderId } })).toBe(1);
  });

  it('refuses to record a payout against a request nobody approved', async () => {
    const { branch, product, customer } = await scene();
    const { orderId } = await paidOrder(branch.id, product.id, customer.id);
    await advance(orderId, OrderStatus.DELIVERED);

    const request = await requests.createForCustomer(customerActor(customer.id), orderId, {
      reason: 'Cold',
    });

    await expect(
      requests.recordRefundIssued(ownerActor(), request.id, { gatewayReference: 'tap_x' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses to approve more than the payment can give back', async () => {
    // The branch says the number out loud to the customer. Discovering at payout
    // time that it was impossible means telling them twice.
    const { branch, product, customer } = await scene();
    const { orderId, totalMinor } = await paidOrder(branch.id, product.id, customer.id);
    await advance(orderId, OrderStatus.DELIVERED);

    const request = await requests.createForCustomer(customerActor(customer.id), orderId, {
      reason: 'Everything was wrong',
    });

    await expect(
      requests.approve(branchActor(), request.id, { amountMinor: totalMinor + 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('closes the cancellation window ten minutes after the order was placed', async () => {
    const { branch, product, customer } = await scene();
    const { orderId } = await paidOrder(branch.id, product.id, customer.id);
    await advance(orderId, OrderStatus.PREPARING);

    // Owner decision: 10 minutes from placement. Pushed back an hour so the
    // window is genuinely shut rather than merely close to it.
    await prisma.order.update({
      where: { id: orderId },
      data: { placedAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    const eligibility = await requests.eligibilityForCustomer(customerActor(customer.id), orderId);
    expect(eligibility.canRequest).toBe(false);
    expect(eligibility.blocker).toBe('WINDOW_CLOSED');

    await expect(
      requests.createForCustomer(customerActor(customer.id), orderId, { reason: 'Too late' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses to withdraw a request that has already been decided', async () => {
    const { branch, product, customer } = await scene();
    const { orderId } = await paidOrder(branch.id, product.id, customer.id);
    await advance(orderId, OrderStatus.DELIVERED);

    const request = await requests.createForCustomer(customerActor(customer.id), orderId, {
      reason: 'Cold',
    });
    await requests.reject(branchActor(), request.id, { note: 'Outside our policy.' });

    await expect(
      requests.withdrawForCustomer(customerActor(customer.id), request.id),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('records a rejection with its note and moves no money', async () => {
    const { branch, product, customer } = await scene();
    const { orderId, paymentId } = await paidOrder(branch.id, product.id, customer.id);
    await advance(orderId, OrderStatus.DELIVERED);

    const request = await requests.createForCustomer(customerActor(customer.id), orderId, {
      reason: 'Wrong sauce',
    });
    const rejected = await requests.reject(branchActor(), request.id, {
      note: 'The order matched what was ordered.',
    });

    expect(rejected.status).toBe(RefundRequestStatus.REJECTED);
    expect(rejected.resolutionNote).toBe('The order matched what was ordered.');
    expect(rejected.refundId).toBeNull();

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.status).toBe(PaymentStatus.PAID);
    expect(payment.refundedAmountMinor).toBe(0);
    expect(await prisma.refund.count({ where: { orderId } })).toBe(0);
  });

  // --- Branch isolation ------------------------------------------------------

  it('isolates the queue and every decision to the staff member’s branches', async () => {
    const mine = await scene();
    const theirs = await scene();
    const otherStaff = await prisma.user.create({
      data: { email: `${unique('staff')}@test`, fullName: 'Other Branch', passwordHash: 'x' },
    });
    const outsider = branchStaffActor(otherStaff.id, [theirs.branch.id]);

    const { orderId } = await paidOrder(mine.branch.id, mine.product.id, mine.customer.id);
    await advance(orderId, OrderStatus.DELIVERED);
    const request = await requests.createForCustomer(customerActor(mine.customer.id), orderId, {
      reason: 'Cold',
    });

    const listed = await requests.listForStaff(outsider, { skip: 0, limit: 50, page: 1 });
    expect(listed.data.map((r) => r.id)).not.toContain(request.id);

    await expect(requests.getForStaff(outsider, request.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(requests.approve(outsider, request.id, {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      requests.reject(outsider, request.id, { note: 'Not mine to decide.' }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // The branch it belongs to reaches it.
    const insider = branchStaffActor(ownerUserId, [mine.branch.id]);
    expect((await requests.getForStaff(insider, request.id)).id).toBe(request.id);
  });
});
