import { randomUUID } from 'node:crypto';

import { Prisma, PrismaClient } from '@prisma/client';

import { allocateOrderNumber, generateReferenceId } from '../../../src/orders/order-number';

/**
 * Minimal record builders for schema tests.
 *
 * Each helper creates only what a foreign key requires, so a test failure
 * points at the constraint under test rather than at unrelated setup.
 */

const unique = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`;

export async function createBranch(
  prisma: PrismaClient,
  overrides: Partial<Prisma.BranchCreateInput> = {},
) {
  return prisma.branch.create({
    data: {
      code: unique('BR'),
      name: 'Test Branch',
      addressLine: '1 Test Street',
      city: 'Riyadh',
      ...overrides,
    },
  });
}

export async function createCustomer(
  prisma: PrismaClient,
  overrides: Partial<Prisma.CustomerCreateInput> = {},
) {
  return prisma.customer.create({
    data: {
      // E.164-shaped, unique per call so tests can run in any order.
      phone: `+9665${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      fullName: 'Test Customer',
      ...overrides,
    },
  });
}

export async function createCategory(prisma: PrismaClient) {
  return prisma.category.create({ data: { name: unique('Category') } });
}

export async function createProduct(
  prisma: PrismaClient,
  categoryId: string,
  overrides: Partial<Prisma.ProductUncheckedCreateInput> = {},
) {
  return prisma.product.create({
    data: {
      categoryId,
      name: 'Test Product',
      sku: unique('SKU'),
      basePriceMinor: 3000,
      ...overrides,
    },
  });
}

interface OrderOptions {
  branchId: string;
  customerId: string;
  couponId?: string;
  totalMinor?: number;
  orderNumber?: string;
  referenceId?: string;
}

export async function createOrder(prisma: PrismaClient, options: OrderOptions) {
  const total = options.totalMinor ?? 11_500;
  // 15% of a 10,000 halala base — arithmetic chosen only to be internally
  // consistent for tests. The real rates come from the Phase 7 engine.
  const taxableBase = Math.round(total / 1.15);

  return prisma.order.create({
    data: {
      // Allocated the same way the order engine allocates it, so a test order
      // occupies a real slot in its branch's series.
      orderNumber: options.orderNumber ?? (await allocateOrderNumber(prisma, options.branchId)),
      referenceId: options.referenceId ?? generateReferenceId(),
      branchId: options.branchId,
      customerId: options.customerId,
      couponId: options.couponId,
      type: 'DELIVERY',
      subtotalMinor: taxableBase,
      taxableBaseMinor: taxableBase,
      vatMinor: total - taxableBase,
      totalMinor: total,
      vatRate: new Prisma.Decimal('0.1500'),
    },
  });
}

export async function createPayment(
  prisma: PrismaClient,
  orderId: string,
  overrides: Partial<Prisma.PaymentUncheckedCreateInput> = {},
) {
  return prisma.payment.create({
    data: {
      orderId,
      amountMinor: 11_500,
      gatewayName: 'test-gateway',
      gatewayPaymentId: unique('gw-pay'),
      ...overrides,
    },
  });
}

export { unique };
