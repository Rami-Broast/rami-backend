import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';

import { ActorKind, type Actor } from '../../src/auth/types/actor';
import { AppConfigModule } from '../../src/config/config.module';
import { CustomersModule } from '../../src/customers/customers.module';
import { CustomersService } from '../../src/customers/customers.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { createCustomer } from './helpers/factories';

describe('CustomersService addresses (integration)', () => {
  const prisma = new PrismaClient();
  let customers: CustomersService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    await prisma.$connect();
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, PrismaModule, CustomersModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    customers = app.get(CustomersService);
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

  it('makes the first address default, and later ones not unless asked', async () => {
    const c = await createCustomer(prisma);
    const first = await customers.create(actor(c.id), { line1: '1 St', city: 'Riyadh' });
    expect(first.isDefault).toBe(true);
    const second = await customers.create(actor(c.id), { line1: '2 St', city: 'Riyadh' });
    expect(second.isDefault).toBe(false);
    const third = await customers.create(actor(c.id), {
      line1: '3 St',
      city: 'Riyadh',
      isDefault: true,
    });
    expect(third.isDefault).toBe(true);
    // Only one default at a time.
    const list = await customers.list(actor(c.id));
    expect(list.filter((a) => a.isDefault)).toHaveLength(1);
    expect(list[0]?.id).toBe(third.id);
  });

  it('soft-deletes and hides an address', async () => {
    const c = await createCustomer(prisma);
    const a = await customers.create(actor(c.id), { line1: '1 St', city: 'Riyadh' });
    await customers.remove(actor(c.id), a.id);
    expect(await customers.list(actor(c.id))).toHaveLength(0);
  });

  it('isolates addresses to their owner', async () => {
    const a = await createCustomer(prisma);
    const b = await createCustomer(prisma);
    const addr = await customers.create(actor(a.id), { line1: '1 St', city: 'Riyadh' });
    await expect(customers.remove(actor(b.id), addr.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a non-customer', async () => {
    const staff: Actor = {
      kind: ActorKind.Staff,
      id: 'x',
      email: 'x@test',
      fullName: 'X',
      roles: [],
      permissions: new Set(),
      branchScope: { kind: 'ALL' },
    };
    await expect(customers.create(staff, { line1: '1', city: 'Riyadh' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  // --- Profile ---------------------------------------------------------------

  it('returns the customer’s own profile with phone view-only', async () => {
    // The phone comes from the factory, which generates a unique one per call:
    // a hardcoded number here would collide with the row left by an earlier run
    // against the same database, since Customer.phone is unique.
    const c = await createCustomer(prisma, { fullName: 'Amal' });
    const profile = await customers.getProfile(actor(c.id));
    expect(profile.id).toBe(c.id);
    expect(profile.fullName).toBe('Amal');
    expect(profile.phone).toBe(c.phone);
  });

  it('updates the display name and leaves the phone unchanged', async () => {
    const c = await createCustomer(prisma, { fullName: 'Old Name' });
    const updated = await customers.updateProfile(actor(c.id), { fullName: 'New Name' });
    expect(updated.fullName).toBe('New Name');
    expect(updated.phone).toBe(c.phone);
    const reloaded = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
    expect(reloaded.fullName).toBe('New Name');
  });

  it('refuses profile access for a non-customer', async () => {
    const staff: Actor = {
      kind: ActorKind.Staff,
      id: 'x',
      email: 'x@test',
      fullName: 'X',
      roles: [],
      permissions: new Set(),
      branchScope: { kind: 'ALL' },
    };
    await expect(customers.getProfile(staff)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
