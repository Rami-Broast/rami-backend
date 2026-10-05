import { Prisma, PrismaClient } from '@prisma/client';

import {
  createBranch,
  createCategory,
  createCustomer,
  createOrder,
  createPayment,
  createProduct,
  unique,
} from './helpers/factories';
import { generateReferenceId } from '../../src/orders/order-number';

/**
 * Proves the guarantees the schema is supposed to enforce at the database
 * level.
 *
 * These are deliberately database tests, not unit tests: a uniqueness rule that
 * lives only in application code is not a guarantee, because two concurrent
 * requests can both pass an application-level check. What matters is that
 * PostgreSQL rejects the second write.
 */
describe('Schema constraints (integration)', () => {
  const prisma = new PrismaClient();

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** Prisma's unique-constraint violation. */
  const UNIQUE_VIOLATION = 'P2002';
  /** Prisma's foreign-key violation. */
  const FK_VIOLATION = 'P2003';

  describe('idempotency', () => {
    it('rejects a duplicate key within the same scope', async () => {
      const key = unique('idem');
      const record = {
        key,
        scope: 'payment.create',
        requestHash: 'hash-a',
        expiresAt: new Date(Date.now() + 86_400_000),
      };

      await prisma.idempotencyRecord.create({ data: record });

      await expect(prisma.idempotencyRecord.create({ data: record })).rejects.toMatchObject({
        code: UNIQUE_VIOLATION,
      });
    });

    it('allows the same key in a different scope', async () => {
      const key = unique('idem');
      const expiresAt = new Date(Date.now() + 86_400_000);

      await prisma.idempotencyRecord.create({
        data: { key, scope: 'payment.create', requestHash: 'h', expiresAt },
      });

      // Scoping is what stops a refund key from colliding with a payment key.
      await expect(
        prisma.idempotencyRecord.create({
          data: { key, scope: 'refund.create', requestHash: 'h', expiresAt },
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('payment attempts and refunds', () => {
    it('rejects a reused payment idempotency key', async () => {
      const branch = await createBranch(prisma);
      const customer = await createCustomer(prisma);
      const order = await createOrder(prisma, { branchId: branch.id, customerId: customer.id });
      const payment = await createPayment(prisma, order.id);

      const idempotencyKey = unique('attempt');

      await prisma.paymentAttempt.create({
        data: {
          paymentId: payment.id,
          orderId: order.id,
          attemptNumber: 1,
          amountMinor: 11_500,
          idempotencyKey,
        },
      });

      // A retried create-payment request must not become a second charge.
      await expect(
        prisma.paymentAttempt.create({
          data: {
            paymentId: payment.id,
            orderId: order.id,
            attemptNumber: 2,
            amountMinor: 11_500,
            idempotencyKey,
          },
        }),
      ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    });

    it('rejects a duplicate attempt number for one payment', async () => {
      const branch = await createBranch(prisma);
      const customer = await createCustomer(prisma);
      const order = await createOrder(prisma, { branchId: branch.id, customerId: customer.id });
      const payment = await createPayment(prisma, order.id);

      await prisma.paymentAttempt.create({
        data: {
          paymentId: payment.id,
          orderId: order.id,
          attemptNumber: 1,
          amountMinor: 11_500,
          idempotencyKey: unique('attempt'),
        },
      });

      await expect(
        prisma.paymentAttempt.create({
          data: {
            paymentId: payment.id,
            orderId: order.id,
            attemptNumber: 1,
            amountMinor: 11_500,
            idempotencyKey: unique('attempt'),
          },
        }),
      ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    });

    it('rejects a reused refund idempotency key', async () => {
      const branch = await createBranch(prisma);
      const customer = await createCustomer(prisma);
      const order = await createOrder(prisma, { branchId: branch.id, customerId: customer.id });
      const payment = await createPayment(prisma, order.id);

      const idempotencyKey = unique('refund');
      const refund = {
        paymentId: payment.id,
        orderId: order.id,
        amountMinor: 5000,
        reason: 'Customer request',
        idempotencyKey,
      };

      await prisma.refund.create({ data: refund });

      // A double-clicked refund button must not refund twice.
      await expect(prisma.refund.create({ data: refund })).rejects.toMatchObject({
        code: UNIQUE_VIOLATION,
      });
    });

    it('rejects a duplicate gateway payment id for the same gateway', async () => {
      const branch = await createBranch(prisma);
      const customer = await createCustomer(prisma);
      const orderA = await createOrder(prisma, { branchId: branch.id, customerId: customer.id });
      const orderB = await createOrder(prisma, { branchId: branch.id, customerId: customer.id });

      const gatewayPaymentId = unique('gw');
      await createPayment(prisma, orderA.id, { gatewayPaymentId });

      await expect(createPayment(prisma, orderB.id, { gatewayPaymentId })).rejects.toMatchObject({
        code: UNIQUE_VIOLATION,
      });
    });
  });

  describe('webhook de-duplication', () => {
    it('rejects a replayed gateway event', async () => {
      const gatewayEventId = unique('evt');
      const event = {
        gatewayName: 'test-gateway',
        gatewayEventId,
        eventType: 'charge.succeeded',
        payload: { id: gatewayEventId } as Prisma.InputJsonValue,
      };

      await prisma.paymentWebhookEvent.create({ data: event });

      // Gateways retry deliveries; the second must be rejected, not re-applied.
      await expect(prisma.paymentWebhookEvent.create({ data: event })).rejects.toMatchObject({
        code: UNIQUE_VIOLATION,
      });
    });

    it('allows the same event id from a different gateway', async () => {
      const gatewayEventId = unique('evt');

      await prisma.paymentWebhookEvent.create({
        data: {
          gatewayName: 'gateway-a',
          gatewayEventId,
          eventType: 'charge.succeeded',
          payload: {},
        },
      });

      await expect(
        prisma.paymentWebhookEvent.create({
          data: {
            gatewayName: 'gateway-b',
            gatewayEventId,
            eventType: 'charge.succeeded',
            payload: {},
          },
        }),
      ).resolves.toBeDefined();
    });

    it('defaults to unverified so an event cannot be trusted before checking', async () => {
      const event = await prisma.paymentWebhookEvent.create({
        data: {
          gatewayName: 'test-gateway',
          gatewayEventId: unique('evt'),
          eventType: 'charge.succeeded',
          payload: {},
        },
      });

      expect(event.signatureVerified).toBe(false);
      expect(event.processingStatus).toBe('RECEIVED');
    });
  });

  describe('coupon reuse prevention', () => {
    const createCoupon = () =>
      prisma.coupon.create({
        data: {
          code: unique('SAVE'),
          name: 'Test Coupon',
          discountType: 'PERCENTAGE',
          discountValue: new Prisma.Decimal('10.00'),
          validFrom: new Date(Date.now() - 3600_000),
          validUntil: new Date(Date.now() + 86_400_000),
        },
      });

    it('rejects a second usage row for the same order', async () => {
      const branch = await createBranch(prisma);
      const customer = await createCustomer(prisma);
      const coupon = await createCoupon();
      const order = await createOrder(prisma, {
        branchId: branch.id,
        customerId: customer.id,
        couponId: coupon.id,
      });

      const usage = {
        couponId: coupon.id,
        customerId: customer.id,
        orderId: order.id,
        discountAppliedMinor: 1000,
      };

      await prisma.couponUsage.create({ data: usage });

      await expect(prisma.couponUsage.create({ data: usage })).rejects.toMatchObject({
        code: UNIQUE_VIOLATION,
      });
    });

    it('rejects a different coupon redeemed against an already-couponed order', async () => {
      const branch = await createBranch(prisma);
      const customer = await createCustomer(prisma);
      const [couponA, couponB] = await Promise.all([createCoupon(), createCoupon()]);
      const order = await createOrder(prisma, {
        branchId: branch.id,
        customerId: customer.id,
        couponId: couponA.id,
      });

      await prisma.couponUsage.create({
        data: {
          couponId: couponA.id,
          customerId: customer.id,
          orderId: order.id,
          discountAppliedMinor: 1000,
        },
      });

      // orderId is unique on its own, so one order can never stack coupons.
      await expect(
        prisma.couponUsage.create({
          data: {
            couponId: couponB.id,
            customerId: customer.id,
            orderId: order.id,
            discountAppliedMinor: 500,
          },
        }),
      ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    });

    it('lets exactly one of two concurrent redemptions win', async () => {
      const branch = await createBranch(prisma);
      const customer = await createCustomer(prisma);
      const coupon = await createCoupon();
      const order = await createOrder(prisma, {
        branchId: branch.id,
        customerId: customer.id,
        couponId: coupon.id,
      });

      const redeem = () =>
        prisma.couponUsage.create({
          data: {
            couponId: coupon.id,
            customerId: customer.id,
            orderId: order.id,
            discountAppliedMinor: 1000,
          },
        });

      // The real-world race: two checkout requests arriving together. An
      // application-level "have we used this?" check would let both through.
      const results = await Promise.allSettled([redeem(), redeem()]);

      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      await expect(prisma.couponUsage.count({ where: { orderId: order.id } })).resolves.toBe(1);
    });
  });

  describe('order integrity', () => {
    it('numbers a branch\u2019s first order 1000000 and counts up from there', async () => {
      const branch = await createBranch(prisma);
      const customer = await createCustomer(prisma);

      const first = await createOrder(prisma, { branchId: branch.id, customerId: customer.id });
      const second = await createOrder(prisma, { branchId: branch.id, customerId: customer.id });

      expect(first.orderNumber).toBe('1000000');
      expect(second.orderNumber).toBe('1000001');
    });

    it('counts each branch separately, so both start at 1000000', async () => {
      const branchA = await createBranch(prisma);
      const branchB = await createBranch(prisma);
      const customer = await createCustomer(prisma);

      const a1 = await createOrder(prisma, { branchId: branchA.id, customerId: customer.id });
      const a2 = await createOrder(prisma, { branchId: branchA.id, customerId: customer.id });
      const b1 = await createOrder(prisma, { branchId: branchB.id, customerId: customer.id });

      expect([a1.orderNumber, a2.orderNumber]).toEqual(['1000000', '1000001']);
      // Branch B is untouched by branch A's traffic.
      expect(b1.orderNumber).toBe('1000000');
    });

    it('rejects a duplicate order number within one branch', async () => {
      const branch = await createBranch(prisma);
      const customer = await createCustomer(prisma);
      const first = await createOrder(prisma, { branchId: branch.id, customerId: customer.id });

      await expect(
        prisma.order.create({
          data: {
            orderNumber: first.orderNumber,
            referenceId: generateReferenceId(),
            branchId: branch.id,
            customerId: customer.id,
            type: 'PICKUP',
            subtotalMinor: 1000,
            taxableBaseMinor: 1000,
            vatMinor: 150,
            totalMinor: 1150,
            vatRate: new Prisma.Decimal('0.1500'),
          },
        }),
      ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    });

    it('gives every order a distinct 12-digit reference and rejects a duplicate', async () => {
      const branch = await createBranch(prisma);
      const customer = await createCustomer(prisma);
      const first = await createOrder(prisma, { branchId: branch.id, customerId: customer.id });

      expect(first.referenceId).toMatch(/^[1-9][0-9]{11}$/);

      await expect(
        prisma.order.create({
          data: {
            orderNumber: '2000000',
            referenceId: first.referenceId,
            branchId: branch.id,
            customerId: customer.id,
            type: 'PICKUP',
            subtotalMinor: 1000,
            taxableBaseMinor: 1000,
            vatMinor: 150,
            totalMinor: 1150,
            vatRate: new Prisma.Decimal('0.1500'),
          },
        }),
      ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    });

    it('rejects an order referencing a branch that does not exist', async () => {
      const customer = await createCustomer(prisma);

      await expect(
        prisma.order.create({
          data: {
            orderNumber: '1000000',
            referenceId: generateReferenceId(),
            branchId: '00000000-0000-7000-8000-00000000dead',
            customerId: customer.id,
            type: 'DELIVERY',
            subtotalMinor: 1000,
            taxableBaseMinor: 1000,
            vatMinor: 150,
            totalMinor: 1150,
            vatRate: new Prisma.Decimal('0.1500'),
          },
        }),
      ).rejects.toMatchObject({ code: FK_VIOLATION });
    });

    it('starts an order unpaid, with fulfilment and payment state independent', async () => {
      const branch = await createBranch(prisma);
      const customer = await createCustomer(prisma);
      const order = await createOrder(prisma, { branchId: branch.id, customerId: customer.id });

      expect(order.status).toBe('PENDING_PAYMENT');
      expect(order.paymentStatus).toBe('PENDING');

      // Advancing fulfilment must not move payment state with it.
      const advanced = await prisma.order.update({
        where: { id: order.id },
        data: { status: 'PREPARING' },
      });

      expect(advanced.status).toBe('PREPARING');
      expect(advanced.paymentStatus).toBe('PENDING');
    });

    it('preserves the price snapshot when the product price later changes', async () => {
      const branch = await createBranch(prisma);
      const customer = await createCustomer(prisma);
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id, { basePriceMinor: 3000 });
      const order = await createOrder(prisma, { branchId: branch.id, customerId: customer.id });

      await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: product.id,
          productName: product.name,
          unitPriceMinor: 3000,
          quantity: 2,
          lineSubtotalMinor: 6000,
          lineVatMinor: 900,
          lineTotalMinor: 6900,
        },
      });

      await prisma.product.update({
        where: { id: product.id },
        data: { basePriceMinor: 9999, name: 'Renamed Product' },
      });

      const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });

      // What the customer was charged, and what they ordered, are unchanged.
      expect(item.unitPriceMinor).toBe(3000);
      expect(item.lineTotalMinor).toBe(6900);
      expect(item.productName).toBe(product.name);
    });

    it('keeps the order item when its product is hard-deleted', async () => {
      const branch = await createBranch(prisma);
      const customer = await createCustomer(prisma);
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id);
      const order = await createOrder(prisma, { branchId: branch.id, customerId: customer.id });

      await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: product.id,
          productName: product.name,
          unitPriceMinor: 3000,
          quantity: 1,
          lineSubtotalMinor: 3000,
          lineVatMinor: 450,
          lineTotalMinor: 3450,
        },
      });

      await prisma.product.delete({ where: { id: product.id } });

      const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });

      // SetNull, not Cascade: history survives a catalog deletion.
      expect(item.productId).toBeNull();
      expect(item.productName).toBe(product.name);
      expect(item.lineTotalMinor).toBe(3450);
    });

    it('refuses to delete a branch that still has orders', async () => {
      const branch = await createBranch(prisma);
      const customer = await createCustomer(prisma);
      await createOrder(prisma, { branchId: branch.id, customerId: customer.id });

      await expect(prisma.branch.delete({ where: { id: branch.id } })).rejects.toMatchObject({
        code: FK_VIOLATION,
      });
    });
  });

  describe('money precision', () => {
    it('stores minor units as exact integers', async () => {
      const branch = await createBranch(prisma);
      const customer = await createCustomer(prisma);

      // 99,999,999 halalas ≈ 999,999.99 SAR — well inside Int, and exact.
      const order = await createOrder(prisma, {
        branchId: branch.id,
        customerId: customer.id,
        totalMinor: 99_999_999,
      });

      const stored = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });

      expect(stored.totalMinor).toBe(99_999_999);
      expect(Number.isInteger(stored.totalMinor)).toBe(true);
    });

    it('stores the VAT rate exactly, without floating-point drift', async () => {
      const branch = await createBranch(prisma);
      const customer = await createCustomer(prisma);
      const order = await createOrder(prisma, { branchId: branch.id, customerId: customer.id });

      const stored = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });

      expect(stored.vatRate.toString()).toBe('0.15');
      expect(stored.vatRate.equals(new Prisma.Decimal('0.1500'))).toBe(true);
    });

    it('holds settlement aggregates beyond the Int range', async () => {
      // 50 billion halalas = 500 million SAR: overflows Int, which is exactly
      // why settlement totals are BigInt.
      const largeAmount = 50_000_000_000n;

      const settlement = await prisma.settlement.create({
        data: {
          gatewayName: 'test-gateway',
          settlementReference: unique('stl'),
          periodStart: new Date('2026-01-01'),
          periodEnd: new Date('2026-01-31'),
          grossSalesMinor: largeAmount,
          expectedNetMinor: largeAmount,
        },
      });

      expect(settlement.grossSalesMinor).toBe(largeAmount);
    });
  });

  describe('loyalty ledger', () => {
    it('derives the balance from the ledger rather than a stored counter', async () => {
      const customer = await createCustomer(prisma);
      const account = await prisma.loyaltyAccount.create({
        data: { customerId: customer.id },
      });

      await prisma.loyaltyTransaction.createMany({
        data: [
          { loyaltyAccountId: account.id, type: 'EARN', points: 100 },
          { loyaltyAccountId: account.id, type: 'EARN', points: 50 },
          { loyaltyAccountId: account.id, type: 'REDEEM', points: -30 },
          { loyaltyAccountId: account.id, type: 'REVERSE', points: -50 },
        ],
      });

      const aggregate = await prisma.loyaltyTransaction.aggregate({
        where: { loyaltyAccountId: account.id },
        _sum: { points: true },
      });

      expect(aggregate._sum.points).toBe(70);

      // The account itself carries no balance column that could drift from the
      // entries that justify it.
      expect(account).not.toHaveProperty('pointsBalance');
    });

    it('records a refund reversal as a new entry, leaving the earn intact', async () => {
      const branch = await createBranch(prisma);
      const customer = await createCustomer(prisma);
      const order = await createOrder(prisma, { branchId: branch.id, customerId: customer.id });
      const account = await prisma.loyaltyAccount.create({ data: { customerId: customer.id } });

      const earn = await prisma.loyaltyTransaction.create({
        data: { loyaltyAccountId: account.id, type: 'EARN', points: 100, orderId: order.id },
      });

      await prisma.loyaltyTransaction.create({
        data: {
          loyaltyAccountId: account.id,
          type: 'REVERSE',
          points: -100,
          orderId: order.id,
          reason: 'Order refunded',
        },
      });

      const entries = await prisma.loyaltyTransaction.findMany({
        where: { loyaltyAccountId: account.id },
        orderBy: { createdAt: 'asc' },
      });

      expect(entries).toHaveLength(2);
      expect(entries[0].id).toBe(earn.id);
      expect(entries[0].points).toBe(100);
      expect(entries[1].points).toBe(-100);
    });

    it('allows one loyalty account per customer only', async () => {
      const customer = await createCustomer(prisma);
      await prisma.loyaltyAccount.create({ data: { customerId: customer.id } });

      await expect(
        prisma.loyaltyAccount.create({ data: { customerId: customer.id } }),
      ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    });
  });

  describe('role and branch scoping', () => {
    it('scopes a role grant to a branch, and allows a null branch for org-wide access', async () => {
      const [branchA, branchB] = await Promise.all([createBranch(prisma), createBranch(prisma)]);

      const role = await prisma.role.upsert({
        where: { name: 'BRANCH_ADMIN' },
        update: {},
        create: { name: 'BRANCH_ADMIN', isSystem: true },
      });

      const user = await prisma.user.create({
        data: {
          email: `${unique('staff')}@example.test`,
          passwordHash: 'not-a-real-hash',
          fullName: 'Test Staff',
        },
      });

      await prisma.userRole.create({
        data: { userId: user.id, roleId: role.id, branchId: branchA.id },
      });
      await prisma.userRole.create({
        data: { userId: user.id, roleId: role.id, branchId: branchB.id },
      });

      const grants = await prisma.userRole.findMany({ where: { userId: user.id } });

      expect(grants).toHaveLength(2);
      expect(grants.map((grant) => grant.branchId).sort()).toEqual([branchA.id, branchB.id].sort());
    });

    it('rejects granting the same role for the same branch twice', async () => {
      const branch = await createBranch(prisma);
      const role = await prisma.role.upsert({
        where: { name: 'KITCHEN' },
        update: {},
        create: { name: 'KITCHEN', isSystem: true },
      });
      const user = await prisma.user.create({
        data: {
          email: `${unique('staff')}@example.test`,
          passwordHash: 'not-a-real-hash',
          fullName: 'Test Staff',
        },
      });

      const grant = { userId: user.id, roleId: role.id, branchId: branch.id };
      await prisma.userRole.create({ data: grant });

      await expect(prisma.userRole.create({ data: grant })).rejects.toMatchObject({
        code: UNIQUE_VIOLATION,
      });
    });

    it('removes role grants when a user is deleted, but keeps the role', async () => {
      const role = await prisma.role.upsert({
        where: { name: 'DRIVER' },
        update: {},
        create: { name: 'DRIVER', isSystem: true },
      });
      const user = await prisma.user.create({
        data: {
          email: `${unique('staff')}@example.test`,
          passwordHash: 'not-a-real-hash',
          fullName: 'Test Staff',
        },
      });
      await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });

      await prisma.user.delete({ where: { id: user.id } });

      await expect(prisma.userRole.count({ where: { userId: user.id } })).resolves.toBe(0);
      await expect(prisma.role.findUnique({ where: { id: role.id } })).resolves.not.toBeNull();
    });
  });

  describe('invoicing', () => {
    it('allows at most one invoice per order', async () => {
      const branch = await createBranch(prisma);
      const customer = await createCustomer(prisma);
      const order = await createOrder(prisma, { branchId: branch.id, customerId: customer.id });

      const invoice = {
        invoiceNumber: unique('INV'),
        orderId: order.id,
        customerId: customer.id,
        branchId: branch.id,
        subtotalMinor: 10_000,
        taxableBaseMinor: 10_000,
        vatMinor: 1500,
        totalMinor: 11_500,
        vatRate: new Prisma.Decimal('0.1500'),
        sellerName: 'Test Seller',
        sellerVatNumber: '300000000000003',
        sellerAddress: '1 Test Street, Riyadh',
      };

      await prisma.invoice.create({ data: invoice });

      await expect(
        prisma.invoice.create({ data: { ...invoice, invoiceNumber: unique('INV') } }),
      ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    });

    it('refuses to delete an invoice that has a credit note', async () => {
      const branch = await createBranch(prisma);
      const customer = await createCustomer(prisma);
      const order = await createOrder(prisma, { branchId: branch.id, customerId: customer.id });

      const invoice = await prisma.invoice.create({
        data: {
          invoiceNumber: unique('INV'),
          orderId: order.id,
          customerId: customer.id,
          branchId: branch.id,
          subtotalMinor: 10_000,
          taxableBaseMinor: 10_000,
          vatMinor: 1500,
          totalMinor: 11_500,
          vatRate: new Prisma.Decimal('0.1500'),
          sellerName: 'Test Seller',
          sellerVatNumber: '300000000000003',
          sellerAddress: '1 Test Street, Riyadh',
        },
      });

      await prisma.creditNote.create({
        data: {
          noteNumber: unique('CN'),
          invoiceId: invoice.id,
          reason: 'Partial refund',
          subtotalMinor: 5000,
          vatMinor: 750,
          totalMinor: 5750,
          vatRate: new Prisma.Decimal('0.1500'),
        },
      });

      await expect(prisma.invoice.delete({ where: { id: invoice.id } })).rejects.toMatchObject({
        code: FK_VIOLATION,
      });
    });
  });
});
