import type { BannersService } from '../../src/banners/banners.service';
import type { CouponsService } from '../../src/coupons/coupons.service';
import { CustomerConfigService } from '../../src/customer-config/customer-config.service';
import type { FeatureFlagsService } from '../../src/feature-flags/feature-flags.service';
import type { HomepageService } from '../../src/homepage/homepage.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { PromotionsService } from '../../src/promotions/promotions.service';

const makePrisma = () => ({
  branch: {
    findMany: jest.fn(),
  },
});

const makeFeatureFlags = () => ({
  getEnabledMap: jest.fn(),
  getConfigVersion: jest.fn(),
});

const makeBanners = () => ({
  listActive: jest.fn().mockResolvedValue([]),
});

const makeHomepage = () => ({
  listEnabled: jest.fn().mockResolvedValue([]),
});

const makePromotions = () => ({
  listActive: jest.fn().mockResolvedValue([]),
});

const makeCoupons = () => ({
  listPublic: jest.fn().mockResolvedValue([]),
});

function createService() {
  const prisma = makePrisma();
  const featureFlags = makeFeatureFlags();
  const banners = makeBanners();
  const homepage = makeHomepage();
  const promotions = makePromotions();
  const coupons = makeCoupons();
  const service = new CustomerConfigService(
    prisma as unknown as PrismaService,
    featureFlags as unknown as FeatureFlagsService,
    banners as unknown as BannersService,
    homepage as unknown as HomepageService,
    promotions as unknown as PromotionsService,
    coupons as unknown as CouponsService,
  );
  return { service, prisma, featureFlags, banners, homepage, promotions, coupons };
}

const branch = (overrides: Record<string, unknown> = {}) => ({
  id: 'branch-1',
  code: 'BR-001',
  name: 'Demo Branch',
  nameAr: null,
  phone: null,
  addressLine: '1 Example Street',
  district: null,
  city: 'Riyadh',
  latitude: null,
  longitude: null,
  isActive: true,
  settings: {
    acceptsDelivery: true,
    acceptsPickup: true,
    isAcceptingOrders: true,
    acceptsCashOnDelivery: false,
    deliveryRadiusKm: 10,
    deliveryFeeMinor: 1500,
    minOrderMinor: 2500,
    prepTimeMinutes: 25,
    openingHours: null,
    timezone: 'Asia/Riyadh',
  },
  ...overrides,
});

describe('CustomerConfigService', () => {
  it('assembles branches, features and version into a config payload', async () => {
    const { service, prisma, featureFlags } = createService();

    prisma.branch.findMany.mockResolvedValue([branch()]);
    featureFlags.getEnabledMap.mockResolvedValue({ online_payment: true, loyalty: false });
    featureFlags.getConfigVersion.mockResolvedValue(3);

    const result = await service.getConfig();

    expect(result.version).toBe(3);
    expect(result.features).toEqual({ online_payment: true, loyalty: false });
    expect(result.branches).toHaveLength(1);
    expect(result.branches[0].code).toBe('BR-001');
    expect(result.branches[0].settings?.deliveryFeeMinor).toBe(1500);
  });

  it('only queries active, non-deleted branches', async () => {
    const { service, prisma, featureFlags } = createService();

    prisma.branch.findMany.mockResolvedValue([]);
    featureFlags.getEnabledMap.mockResolvedValue({});
    featureFlags.getConfigVersion.mockResolvedValue(1);

    await service.getConfig();

    expect(prisma.branch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isActive: true, deletedAt: null },
      }),
    );
  });

  it('converts Decimal latitude/longitude to numbers', async () => {
    const { service, prisma, featureFlags } = createService();

    prisma.branch.findMany.mockResolvedValue([branch({ latitude: 24.7136, longitude: 46.6753 })]);
    featureFlags.getEnabledMap.mockResolvedValue({});
    featureFlags.getConfigVersion.mockResolvedValue(1);

    const result = await service.getConfig();

    expect(result.branches[0].latitude).toBe(24.7136);
    expect(result.branches[0].longitude).toBe(46.6753);
    expect(typeof result.branches[0].latitude).toBe('number');
  });

  it('returns null settings when a branch has none', async () => {
    const { service, prisma, featureFlags } = createService();

    prisma.branch.findMany.mockResolvedValue([branch({ settings: null })]);
    featureFlags.getEnabledMap.mockResolvedValue({});
    featureFlags.getConfigVersion.mockResolvedValue(1);

    const result = await service.getConfig();

    expect(result.branches[0].settings).toBeNull();
  });

  it('returns an empty branch list when no active branches exist', async () => {
    const { service, prisma, featureFlags } = createService();

    prisma.branch.findMany.mockResolvedValue([]);
    featureFlags.getEnabledMap.mockResolvedValue({ pickup: true });
    featureFlags.getConfigVersion.mockResolvedValue(1);

    const result = await service.getConfig();

    expect(result.branches).toEqual([]);
    expect(result.features).toEqual({ pickup: true });
  });

  it('maps address from addressLine field', async () => {
    const { service, prisma, featureFlags } = createService();

    prisma.branch.findMany.mockResolvedValue([branch({ addressLine: '123 Main St' })]);
    featureFlags.getEnabledMap.mockResolvedValue({});
    featureFlags.getConfigVersion.mockResolvedValue(1);

    const result = await service.getConfig();

    expect(result.branches[0].address).toBe('123 Main St');
  });
});
