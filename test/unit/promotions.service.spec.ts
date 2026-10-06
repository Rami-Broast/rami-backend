import { NotFoundException } from '@nestjs/common';
import { DiscountType } from '@prisma/client';

import { PromotionsService } from '../../src/promotions/promotions.service';
import { PrismaService } from '../../src/prisma/prisma.service';

function mockPrisma(): {
  promotion: Record<string, jest.Mock>;
  promotionItem: Record<string, jest.Mock>;
  $transaction: jest.Mock;
} {
  const mock = {
    promotion: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    promotionItem: {
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  mock.$transaction.mockImplementation((fn: (tx: typeof mock) => unknown) => fn(mock));
  return mock;
}

function promoRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'promo-1',
    name: 'Summer Sale',
    nameAr: null,
    description: null,
    descriptionAr: null,
    imageUrl: null,
    discountType: DiscountType.PERCENTAGE,
    discountValue: 10,
    maxDiscountMinor: null,
    branchIds: [],
    startsAt: new Date('2026-06-01T00:00:00Z'),
    endsAt: new Date('2026-09-01T00:00:00Z'),
    isActive: false,
    priority: 0,
    deletedAt: null,
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-01T00:00:00Z'),
    items: [],
    ...overrides,
  };
}

describe('PromotionsService', () => {
  let service: PromotionsService;
  let prisma: ReturnType<typeof mockPrisma>;

  beforeEach(() => {
    prisma = mockPrisma();
    service = new PromotionsService(prisma as unknown as PrismaService);
  });

  describe('list', () => {
    it('returns non-deleted promotions ordered by priority then createdAt desc', async () => {
      const rows = [promoRow({ id: 'p-1' }), promoRow({ id: 'p-2' })];
      prisma.promotion.findMany.mockResolvedValue(rows);

      const result = await service.list();

      expect(result).toBe(rows);
      expect(prisma.promotion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deletedAt: null },
          orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
        }),
      );
    });
  });

  describe('findById', () => {
    it('returns a promotion by ID', async () => {
      prisma.promotion.findUnique.mockResolvedValue(promoRow());
      const result = await service.findById('promo-1');
      expect(result).toEqual(promoRow());
    });

    it('throws NotFoundException when not found', async () => {
      prisma.promotion.findUnique.mockResolvedValue(null);
      await expect(service.findById('missing')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when soft-deleted', async () => {
      prisma.promotion.findUnique.mockResolvedValue(promoRow({ deletedAt: new Date() }));
      await expect(service.findById('promo-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('creates a promotion with product items', async () => {
      prisma.promotion.create.mockResolvedValue(promoRow());

      const result = await service.create({
        name: 'Summer Sale',
        discountType: DiscountType.PERCENTAGE,
        discountValue: 10,
        startsAt: '2026-06-01T00:00:00Z',
        endsAt: '2026-09-01T00:00:00Z',
        productIds: ['prod-1', 'prod-2'],
      });

      expect(result).toEqual(promoRow());
      const call = prisma.promotion.create.mock.calls[0] as unknown[];
      const arg = call[0] as { data: Record<string, unknown> };
      expect(arg.data.name).toBe('Summer Sale');
      expect(arg.data.startsAt).toEqual(new Date('2026-06-01T00:00:00Z'));
    });

    it('converts date strings to Date objects', async () => {
      prisma.promotion.create.mockResolvedValue(promoRow());

      await service.create({
        name: 'Test',
        discountType: DiscountType.FIXED_AMOUNT,
        discountValue: 500,
        startsAt: '2026-07-01T00:00:00Z',
        endsAt: '2026-08-01T00:00:00Z',
      });

      const call = prisma.promotion.create.mock.calls[0] as unknown[];
      const arg = call[0] as { data: Record<string, unknown> };
      expect(arg.data.startsAt).toEqual(new Date('2026-07-01T00:00:00Z'));
      expect(arg.data.endsAt).toEqual(new Date('2026-08-01T00:00:00Z'));
    });
  });

  describe('publish', () => {
    it('sets isActive to true', async () => {
      prisma.promotion.findUnique.mockResolvedValue(promoRow());
      prisma.promotion.update.mockResolvedValue(promoRow({ isActive: true }));

      await service.publish('promo-1');

      const call = prisma.promotion.update.mock.calls[0] as unknown[];
      const arg = call[0] as { data: Record<string, unknown> };
      expect(arg.data.isActive).toBe(true);
    });
  });

  describe('unpublish', () => {
    it('sets isActive to false', async () => {
      prisma.promotion.findUnique.mockResolvedValue(promoRow({ isActive: true }));
      prisma.promotion.update.mockResolvedValue(promoRow({ isActive: false }));

      await service.unpublish('promo-1');

      const call = prisma.promotion.update.mock.calls[0] as unknown[];
      const arg = call[0] as { data: Record<string, unknown> };
      expect(arg.data.isActive).toBe(false);
    });
  });

  describe('remove', () => {
    it('soft-deletes by setting deletedAt', async () => {
      prisma.promotion.findUnique.mockResolvedValue(promoRow());
      prisma.promotion.update.mockResolvedValue(promoRow({ deletedAt: new Date() }));

      await service.remove('promo-1');

      const call = prisma.promotion.update.mock.calls[0] as unknown[];
      const arg = call[0] as { data: Record<string, unknown> };
      expect(arg.data.deletedAt).toBeInstanceOf(Date);
    });

    it('throws NotFoundException when not found', async () => {
      prisma.promotion.findUnique.mockResolvedValue(null);
      await expect(service.remove('missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('listActive', () => {
    it('returns only active, non-deleted promos within the date window', async () => {
      const active = promoRow({ id: 'p-active', isActive: true });
      prisma.promotion.findMany.mockResolvedValue([active]);

      const result = await service.listActive();

      expect(result).toHaveLength(1);
      expect(prisma.promotion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            isActive: true,
            deletedAt: null,
          }) as Record<string, unknown>,
        }),
      );
    });

    it('filters by branchId when provided', async () => {
      const allBranches = promoRow({ id: 'p-all', branchIds: [], isActive: true });
      const branch1 = promoRow({ id: 'p-1', branchIds: ['branch-1'], isActive: true });
      const branch2 = promoRow({ id: 'p-2', branchIds: ['branch-2'], isActive: true });
      prisma.promotion.findMany.mockResolvedValue([allBranches, branch1, branch2]);

      const result = await service.listActive('branch-1');

      expect(result).toHaveLength(2);
      expect(result.map((p: { id: string }) => p.id)).toEqual(['p-all', 'p-1']);
    });
  });
});
