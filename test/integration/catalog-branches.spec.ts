import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';

import { AppConfigModule } from '../../src/config/config.module';
import { CatalogService } from '../../src/menu/catalog.service';
import { MenuModule } from '../../src/menu/menu.module';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { VatModule } from '../../src/vat/vat.module';
import { createBranch } from './helpers/factories';

/**
 * The public branches list (customer app). Proves only active branches appear,
 * with the customer-facing settings a shopper needs and nothing internal.
 */
describe('CatalogService.listBranches (integration)', () => {
  const prisma = new PrismaClient();
  let catalog: CatalogService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    await prisma.$connect();
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, PrismaModule, VatModule, MenuModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    catalog = app.get(CatalogService);
    close = () => app.close();
  });

  afterAll(async () => {
    await close?.();
    await prisma.$disconnect();
  });

  it('lists active branches with their customer-facing settings', async () => {
    const branch = await createBranch(prisma);
    await prisma.branchSetting.create({
      data: {
        branchId: branch.id,
        acceptsCashOnDelivery: true,
        deliveryFeeMinor: 1500,
        minOrderMinor: 3000,
      },
    });

    const list = await catalog.listBranches();
    const found = list.find((b) => b.id === branch.id);

    expect(found).toBeDefined();
    expect(found?.acceptsCashOnDelivery).toBe(true);
    expect(found?.deliveryFeeMinor).toBe(1500);
    expect(found?.minOrderMinor).toBe(3000);
    // No internal-only fields leak.
    expect(found as Record<string, unknown>).not.toHaveProperty('settings');
  });

  it('excludes inactive branches', async () => {
    const branch = await createBranch(prisma, { isActive: false });
    const list = await catalog.listBranches();
    expect(list.find((b) => b.id === branch.id)).toBeUndefined();
  });
});
