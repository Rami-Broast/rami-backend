import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';

import { AuthModule } from '../../src/auth/auth.module';
import { TokenService } from '../../src/auth/services/token.service';
import { ActorKind, type Actor } from '../../src/auth/types/actor';
import { AppConfigModule } from '../../src/config/config.module';
import { CustomersModule } from '../../src/customers/customers.module';
import { CustomersService } from '../../src/customers/customers.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { createBranch, createCustomer, createOrder } from './helpers/factories';

/**
 * Account deletion (Apple App Store Review Guideline 5.1.1(v)).
 *
 * The rule under test is that "delete my account" **anonymises**: the personal
 * data goes, the commercial record stays. Both halves matter, and each fails in
 * a way nobody would notice from the app:
 *
 * - Erasing too little leaves a name and a phone number in a database the
 *   customer was told had been cleared.
 * - Erasing too much takes the restaurant's sales and VAT records with it —
 *   the reports in `src/reports/` are built from those orders, so a deletion
 *   that removed them would silently change last month's revenue.
 */
describe('Account deletion (integration)', () => {
  const prisma = new PrismaClient();
  let customers: CustomersService;
  let tokens: TokenService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    await prisma.$connect();
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, PrismaModule, AuthModule, CustomersModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    customers = app.get(CustomersService);
    tokens = app.get(TokenService);
    close = () => app.close();
  });

  afterAll(async () => {
    await close?.();
    await prisma.$disconnect();
  });

  const actor = (id: string): Actor => ({
    kind: ActorKind.Customer,
    id,
    phone: '+966500000000',
    permissions: new Set(),
    branchScope: { kind: 'NONE' },
  });

  it('erases the personal data and deactivates the account', async () => {
    const c = await createCustomer(prisma, {
      fullName: 'Layla Ahmed',
      email: `layla-${Date.now()}@example.com`,
    });
    await customers.create(actor(c.id), {
      line1: '12 King Fahd Road',
      city: 'Riyadh',
      district: 'Al Olaya',
      latitude: 24.7136,
      longitude: 46.6753,
      notes: 'Second gate, ring twice',
    });

    await customers.deleteAccount(actor(c.id));

    const row = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.fullName).toBeNull();
    expect(row.email).toBeNull();
    expect(row.isActive).toBe(false);
    expect(row.deletedAt).not.toBeNull();

    const addresses = await prisma.customerAddress.findMany({ where: { customerId: c.id } });
    expect(addresses).toHaveLength(1);
    for (const a of addresses) {
      expect(a.line1).toBe('');
      expect(a.city).toBe('');
      expect(a.district).toBeNull();
      expect(a.notes).toBeNull();
      expect(a.latitude).toBeNull();
      expect(a.longitude).toBeNull();
      expect(a.deletedAt).not.toBeNull();
    }
  });

  it('releases the phone number so the same person can sign up again', async () => {
    const c = await createCustomer(prisma);
    const phone = c.phone;

    await customers.deleteAccount(actor(c.id));

    const row = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.phone).not.toBe(phone);
    // Not a dialable number: nothing a keypad produces can collide with it, and
    // no staff screen can ring it by mistake.
    expect(row.phone.startsWith('+')).toBe(false);

    // The real number is free, so the unique constraint accepts it again.
    // Deleting an account must not be a permanent ban.
    const returning = await createCustomer(prisma, { phone });
    expect(returning.id).not.toBe(c.id);
  });

  it('keeps the order, because it is the restaurant sales record', async () => {
    const branch = await createBranch(prisma);
    const c = await createCustomer(prisma);
    const order = await createOrder(prisma, { branchId: branch.id, customerId: c.id });

    await customers.deleteAccount(actor(c.id));

    const kept = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(kept.totalMinor).toBe(order.totalMinor);
    expect(kept.customerId).toBe(c.id);
    expect(kept.deletedAt).toBeNull();
  });

  it('revokes every session, so other devices are signed out', async () => {
    const c = await createCustomer(prisma);
    await tokens.issuePair({ kind: ActorKind.Customer, id: c.id });
    await tokens.issuePair({ kind: ActorKind.Customer, id: c.id });

    await customers.deleteAccount(actor(c.id));

    const live = await prisma.refreshToken.count({
      where: { customerId: c.id, revokedAt: null },
    });
    expect(live).toBe(0);
  });

  it('invalidates an OTP challenge in flight for the released number', async () => {
    const c = await createCustomer(prisma);
    const challenge = await prisma.otpChallenge.create({
      data: {
        phone: c.phone,
        codeHash: 'not-a-real-hash',
        expiresAt: new Date(Date.now() + 300_000),
      },
    });

    await customers.deleteAccount(actor(c.id));

    const after = await prisma.otpChallenge.findUniqueOrThrow({ where: { id: challenge.id } });
    expect(after.invalidatedAt).not.toBeNull();
  });

  it('is not repeatable, and is refused to staff', async () => {
    const c = await createCustomer(prisma);
    await customers.deleteAccount(actor(c.id));
    await expect(customers.deleteAccount(actor(c.id))).rejects.toThrow(NotFoundException);

    const staff: Actor = {
      kind: ActorKind.Staff,
      id: c.id,
      email: 'owner@example.com',
      permissions: new Set(),
      branchScope: { kind: 'ALL' },
    } as unknown as Actor;
    await expect(customers.deleteAccount(staff)).rejects.toThrow(ForbiddenException);
  });

  it('leaves a deleted account unable to read its own profile', async () => {
    const c = await createCustomer(prisma);
    await customers.deleteAccount(actor(c.id));
    await expect(customers.getProfile(actor(c.id))).rejects.toThrow(NotFoundException);
  });
});
