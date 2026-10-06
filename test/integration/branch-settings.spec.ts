import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';

import { BranchSettingsService } from '../../src/branches/branch-settings.service';
import { BranchesModule } from '../../src/branches/branches.module';
import { AppConfigModule } from '../../src/config/config.module';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { createBranch } from './helpers/factories';

describe('BranchSettingsService (integration)', () => {
  const prisma = new PrismaClient();
  let settings: BranchSettingsService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    await prisma.$connect();
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, PrismaModule, BranchesModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    settings = app.get(BranchSettingsService);
    close = () => app.close();
  });

  afterAll(async () => {
    await close?.();
    await prisma.$disconnect();
  });

  it('turns pickup and delivery on and off', async () => {
    const branch = await createBranch(prisma);
    await prisma.branchSetting.create({ data: { branchId: branch.id } });

    const off = await settings.update(branch.id, { acceptsPickup: false, acceptsDelivery: false });
    expect(off.acceptsPickup).toBe(false);
    expect(off.acceptsDelivery).toBe(false);

    const on = await settings.update(branch.id, { acceptsPickup: true });
    expect(on.acceptsPickup).toBe(true);
    // A partial update leaves the untouched field alone.
    expect(on.acceptsDelivery).toBe(false);
  });

  it('creates settings on first update if a branch has none', async () => {
    const branch = await createBranch(prisma);
    const created = await settings.update(branch.id, { deliveryFeeMinor: 2000 });
    expect(created.deliveryFeeMinor).toBe(2000);
  });

  it('404s for an unknown branch', async () => {
    await expect(
      settings.update('00000000-0000-7000-8000-000000000000', { acceptsPickup: true }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
