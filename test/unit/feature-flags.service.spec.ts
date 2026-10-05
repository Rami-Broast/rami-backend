import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { FeatureFlagsService } from '../../src/feature-flags/feature-flags.service';

const SELECT = { id: true, key: true, enabled: true, description: true, updatedAt: true };

const flag = (overrides: Record<string, unknown> = {}) => ({
  id: 'flag-1',
  key: 'online_payment',
  enabled: true,
  description: 'Online payment via Tap',
  updatedAt: new Date('2026-01-01'),
  ...overrides,
});

const makePrisma = () => ({
  featureFlag: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  configVersion: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
  },
  $transaction: jest.fn(
    (
      fn: (tx: {
        featureFlag: { update: jest.Mock };
        configVersion: { upsert: jest.Mock };
      }) => unknown,
    ) =>
      fn({
        featureFlag: { update: jest.fn() },
        configVersion: { upsert: jest.fn() },
      }),
  ),
});

type MockPrisma = ReturnType<typeof makePrisma>;

function createService(prisma: MockPrisma = makePrisma()) {
  return {
    service: new FeatureFlagsService(
      prisma as unknown as ConstructorParameters<typeof FeatureFlagsService>[0],
    ),
    prisma,
  };
}

describe('FeatureFlagsService', () => {
  describe('list', () => {
    it('returns flags ordered by key', async () => {
      const { service, prisma } = createService();
      const flags = [flag({ key: 'a' }), flag({ key: 'b' })];
      prisma.featureFlag.findMany.mockResolvedValue(flags);

      const result = await service.list();

      expect(result).toEqual(flags);
      expect(prisma.featureFlag.findMany).toHaveBeenCalledWith({
        select: SELECT,
        orderBy: { key: 'asc' },
      });
    });
  });

  describe('findByKey', () => {
    it('returns a flag when found', async () => {
      const { service, prisma } = createService();
      const f = flag();
      prisma.featureFlag.findUnique.mockResolvedValue(f);

      const result = await service.findByKey('online_payment');

      expect(result).toEqual(f);
      expect(prisma.featureFlag.findUnique).toHaveBeenCalledWith({
        where: { key: 'online_payment' },
        select: SELECT,
      });
    });

    it('throws NotFoundException for an unknown key', async () => {
      const { service, prisma } = createService();
      prisma.featureFlag.findUnique.mockResolvedValue(null);

      await expect(service.findByKey('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('creates a flag and returns it', async () => {
      const { service, prisma } = createService();
      const f = flag();
      prisma.featureFlag.create.mockResolvedValue(f);

      const result = await service.create(
        { key: 'online_payment', enabled: true, description: 'desc' },
        'user-1',
      );

      expect(result).toEqual(f);
      expect(prisma.featureFlag.create).toHaveBeenCalledWith({
        data: {
          key: 'online_payment',
          enabled: true,
          description: 'desc',
          updatedByUserId: 'user-1',
        },
        select: SELECT,
      });
    });

    it('throws ConflictException on duplicate key', async () => {
      const { service, prisma } = createService();
      const uniqueViolation = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion: '0.0.0',
      });
      prisma.featureFlag.create.mockRejectedValue(uniqueViolation);

      await expect(service.create({ key: 'dup', enabled: false }, 'user-1')).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('update', () => {
    it('updates the flag and bumps config version in a transaction', async () => {
      const { service, prisma } = createService();
      const f = flag();
      prisma.featureFlag.findUnique.mockResolvedValue(f);

      const updatedFlag = flag({ enabled: false });
      const txFeatureFlag = { update: jest.fn().mockResolvedValue(updatedFlag) };
      const txConfigVersion = { upsert: jest.fn() };
      prisma.$transaction.mockImplementation(
        (
          fn: (tx: {
            featureFlag: typeof txFeatureFlag;
            configVersion: typeof txConfigVersion;
          }) => unknown,
        ) => fn({ featureFlag: txFeatureFlag, configVersion: txConfigVersion }),
      );

      const result = await service.update('online_payment', { enabled: false }, 'user-1');

      expect(result).toEqual(updatedFlag);
      expect(txFeatureFlag.update).toHaveBeenCalledWith({
        where: { key: 'online_payment' },
        data: { enabled: false, updatedByUserId: 'user-1' },
        select: SELECT,
      });
      expect(txConfigVersion.upsert).toHaveBeenCalled();
    });

    it('throws NotFoundException if the flag does not exist', async () => {
      const { service, prisma } = createService();
      prisma.featureFlag.findUnique.mockResolvedValue(null);

      await expect(service.update('nonexistent', { enabled: true }, 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getEnabledMap', () => {
    it('returns a key-to-boolean map of all flags', async () => {
      const { service, prisma } = createService();
      prisma.featureFlag.findMany.mockResolvedValue([
        { key: 'online_payment', enabled: true },
        { key: 'loyalty', enabled: false },
      ]);

      const result = await service.getEnabledMap();

      expect(result).toEqual({
        online_payment: true,
        loyalty: false,
      });
    });

    it('returns an empty map when no flags exist', async () => {
      const { service, prisma } = createService();
      prisma.featureFlag.findMany.mockResolvedValue([]);

      expect(await service.getEnabledMap()).toEqual({});
    });
  });

  describe('getConfigVersion', () => {
    it('returns the version when the row exists', async () => {
      const { service, prisma } = createService();
      prisma.configVersion.findUnique.mockResolvedValue({ version: 5 });

      expect(await service.getConfigVersion()).toBe(5);
    });

    it('returns 0 when no config version row exists yet', async () => {
      const { service, prisma } = createService();
      prisma.configVersion.findUnique.mockResolvedValue(null);

      expect(await service.getConfigVersion()).toBe(0);
    });
  });
});
