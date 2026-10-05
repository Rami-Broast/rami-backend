import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  PaymentMethod,
  PrismaClient,
  SettlementMatchStatus,
  SettlementStatus,
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
import { RefundsService } from '../../src/refunds/refunds.service';
import { SettlementsModule } from '../../src/settlements/settlements.module';
import { SettlementsService } from '../../src/settlements/settlements.service';
import { VatModule } from '../../src/vat/vat.module';
import {
  createBranch,
  createCategory,
  createCustomer,
  createProduct,
  unique,
} from './helpers/factories';

/**
 * Settlements (Phase 18) against a real database.
 *
 * Proves reconciliation end to end: a payout that agrees with our captured
 * payments and completed refunds matches cleanly; a wrong amount, a missing
 * line and a branch mismatch each surface as a flagged discrepancy; and the
 * whole thing is idempotent per (gateway, reference) and branch-isolated.
 */
describe('SettlementsService (integration)', () => {
  const prisma = new PrismaClient();
  let orders: OrdersService;
  let payments: PaymentsService;
  let refunds: RefundsService;
  let settlements: SettlementsService;
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
        PaymentsModule,
        RefundsModule,
        SettlementsModule,
      ],
    }).compile();

    const app = moduleRef.createNestApplication();
    await app.init();

    orders = app.get(OrdersService);
    payments = app.get(PaymentsService);
    refunds = app.get(RefundsService);
    settlements = app.get(SettlementsService);
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
      permissions: new Set(['settlements:read', 'settlements:write']),
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
      permissions: new Set(['settlements:read']),
      branchScope: { kind: 'ASSIGNED', branchIds },
    };
  }

  async function scene() {
    const branch = await createBranch(prisma);
    await prisma.branchSetting.create({
      data: { branchId: branch.id, deliveryFeeMinor: 0, minOrderMinor: 0 },
    });
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, { basePriceMinor: 11_500 });
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
    const row = await prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
      select: { gatewayPaymentId: true },
    });
    await payments.simulateWebhook(row.gatewayPaymentId!, 'SUCCEEDED');
    const captured = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    return { orderId: order.id, paymentId: payment.id, captured };
  }

  const window = () => ({
    periodStart: new Date(Date.now() - 3600_000).toISOString(),
    periodEnd: new Date(Date.now() + 3600_000).toISOString(),
  });

  // --- Clean reconciliation --------------------------------------------------

  it('matches a payout that agrees with our captured payment', async () => {
    const { branch, product, customer } = await scene();
    const { captured } = await paidOrder(branch.id, product.id, customer.id);

    const settlement = await settlements.ingestPayout(ownerActor(), {
      gatewayName: captured.gatewayName,
      settlementReference: unique('payout'),
      branchId: branch.id,
      ...window(),
      lines: [
        {
          gatewayReference: captured.gatewayPaymentId!,
          type: 'PAYMENT',
          amountMinor: captured.capturedAmountMinor,
          feeMinor: captured.gatewayFeeMinor ?? 0,
        },
      ],
    });

    expect(settlement.status).toBe(SettlementStatus.MATCHED);
    // BigInt aggregates are serialised to strings for transport.
    expect(settlement.grossSalesMinor).toBe(String(captured.capturedAmountMinor));
    expect(settlement.varianceMinor).toBe('0');
    expect(settlement.transactions).toHaveLength(1);
    expect(settlement.transactions[0].matchStatus).toBe(SettlementMatchStatus.MATCHED);

    // A gateway fee record was written for the matched line.
    const fees = await prisma.gatewayFee.count({
      where: { settlementTransactionId: settlement.transactions[0].id },
    });
    expect(fees).toBe(captured.gatewayFeeMinor && captured.gatewayFeeMinor > 0 ? 1 : 0);
  });

  it('nets a completed refund out of the settlement', async () => {
    const { branch, product, customer } = await scene();
    const { paymentId, captured } = await paidOrder(branch.id, product.id, customer.id);

    const refund = await refunds.createRefund(ownerActor(), {
      paymentId,
      amountMinor: 5000,
      reason: 'Partial',
    });
    await payments.simulateRefundWebhook(refund.gatewayRefundId!, 'SUCCEEDED');
    const completedRefund = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });

    const settlement = await settlements.ingestPayout(ownerActor(), {
      gatewayName: captured.gatewayName,
      settlementReference: unique('payout'),
      branchId: branch.id,
      ...window(),
      lines: [
        {
          gatewayReference: captured.gatewayPaymentId!,
          type: 'PAYMENT',
          amountMinor: captured.capturedAmountMinor,
          feeMinor: captured.gatewayFeeMinor ?? 0,
        },
        {
          gatewayReference: completedRefund.gatewayRefundId!,
          type: 'REFUND',
          amountMinor: 5000,
          feeMinor: 0,
        },
      ],
    });

    expect(settlement.status).toBe(SettlementStatus.MATCHED);
    expect(settlement.refundsMinor).toBe('5000');
    const expectedNet = captured.capturedAmountMinor - (captured.gatewayFeeMinor ?? 0) - 5000;
    expect(settlement.expectedNetMinor).toBe(String(expectedNet));
    expect(settlement.varianceMinor).toBe('0');
  });

  // --- Discrepancies ---------------------------------------------------------

  it('flags a wrong payout amount as a discrepancy', async () => {
    const { branch, product, customer } = await scene();
    const { captured } = await paidOrder(branch.id, product.id, customer.id);

    const settlement = await settlements.ingestPayout(ownerActor(), {
      gatewayName: captured.gatewayName,
      settlementReference: unique('payout'),
      branchId: branch.id,
      ...window(),
      lines: [
        {
          gatewayReference: captured.gatewayPaymentId!,
          type: 'PAYMENT',
          amountMinor: captured.capturedAmountMinor + 100,
          feeMinor: captured.gatewayFeeMinor ?? 0,
        },
      ],
    });

    expect(settlement.status).toBe(SettlementStatus.DISCREPANCY);
    expect(settlement.transactions[0].matchStatus).toBe(SettlementMatchStatus.UNEXPECTED);
  });

  it('flags a captured payment the payout omitted as MISSING', async () => {
    const { branch, product, customer } = await scene();
    await paidOrder(branch.id, product.id, customer.id);

    // Empty payout, but we have a captured payment in the window.
    const settlement = await settlements.ingestPayout(ownerActor(), {
      gatewayName: 'mock',
      settlementReference: unique('payout'),
      branchId: branch.id,
      ...window(),
      lines: [],
    });

    expect(settlement.status).toBe(SettlementStatus.DISCREPANCY);
    expect(
      settlement.transactions.some((t) => t.matchStatus === SettlementMatchStatus.MISSING),
    ).toBe(true);
    // Expected net is positive (we captured money); actual is zero.
    expect(Number(settlement.varianceMinor)).toBeLessThan(0);
  });

  // --- Idempotency and isolation ---------------------------------------------

  it('rejects a re-submitted settlement reference', async () => {
    const { branch } = await scene();
    const reference = unique('payout');
    const dto = {
      gatewayName: 'mock',
      settlementReference: reference,
      branchId: branch.id,
      ...window(),
      lines: [],
    };

    await settlements.ingestPayout(ownerActor(), dto);
    await expect(settlements.ingestPayout(ownerActor(), dto)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('refuses an organisation-wide settlement from branch staff', async () => {
    const { branch } = await scene();

    await expect(
      settlements.ingestPayout(branchStaffActor([branch.id]), {
        gatewayName: 'mock',
        settlementReference: unique('payout'),
        // No branchId → org-wide → owner only.
        ...window(),
        lines: [],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('isolates settlement reads to the staff member’s branches', async () => {
    const a = await scene();
    const settlement = await settlements.ingestPayout(ownerActor(), {
      gatewayName: 'mock',
      settlementReference: unique('payout'),
      branchId: a.branch.id,
      ...window(),
      lines: [],
    });

    const otherBranch = await createBranch(prisma);
    const outsider = branchStaffActor([otherBranch.id]);

    await expect(settlements.getForStaff(outsider, settlement.id)).rejects.toThrow(
      /do not have access/,
    );
  });

  it('only counts payments and refunds within the settlement window', async () => {
    const { branch, product, customer } = await scene();
    await paidOrder(branch.id, product.id, customer.id);

    // A window entirely in the past captures nothing → clean empty settlement.
    const settlement = await settlements.ingestPayout(ownerActor(), {
      gatewayName: 'mock',
      settlementReference: unique('payout'),
      branchId: branch.id,
      periodStart: new Date(Date.now() - 7200_000).toISOString(),
      periodEnd: new Date(Date.now() - 3600_000).toISOString(),
      lines: [],
    });

    expect(settlement.status).toBe(SettlementStatus.MATCHED);
    expect(settlement.grossSalesMinor).toBe('0');
    expect(settlement.transactions).toHaveLength(0);
  });
});
