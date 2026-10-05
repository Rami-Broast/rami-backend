import { NotFoundException } from '@nestjs/common';
import { HomepageSectionKind } from '@prisma/client';

import { HomepageService } from '../../src/homepage/homepage.service';
import { PrismaService } from '../../src/prisma/prisma.service';

function mockPrisma() {
  return {
    homepageSection: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    $transaction: jest.fn(),
  };
}

function sectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sec-1',
    kind: HomepageSectionKind.BANNERS,
    title: 'Banners',
    titleAr: null,
    position: 0,
    enabled: true,
    config: null,
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
}

describe('HomepageService', () => {
  let service: HomepageService;
  let prisma: ReturnType<typeof mockPrisma>;

  beforeEach(() => {
    prisma = mockPrisma();
    service = new HomepageService(prisma as unknown as PrismaService);
  });

  describe('list', () => {
    it('returns all sections ordered by position', async () => {
      const rows = [sectionRow({ id: 's-1', position: 0 }), sectionRow({ id: 's-2', position: 1 })];
      prisma.homepageSection.findMany.mockResolvedValue(rows);

      const result = await service.list();

      expect(result).toBe(rows);
      expect(prisma.homepageSection.findMany).toHaveBeenCalledWith({
        orderBy: { position: 'asc' },
      });
    });
  });

  describe('listEnabled', () => {
    it('returns only enabled sections ordered by position', async () => {
      const rows = [sectionRow({ enabled: true })];
      prisma.homepageSection.findMany.mockResolvedValue(rows);

      const result = await service.listEnabled();

      expect(result).toBe(rows);
      expect(prisma.homepageSection.findMany).toHaveBeenCalledWith({
        where: { enabled: true },
        orderBy: { position: 'asc' },
      });
    });
  });

  describe('upsert', () => {
    it('upserts a section by kind', async () => {
      const row = sectionRow();
      prisma.homepageSection.upsert.mockResolvedValue(row);

      const result = await service.upsert({
        kind: HomepageSectionKind.BANNERS,
        title: 'Banners',
        position: 0,
        enabled: true,
      });

      expect(result).toEqual(row);
      expect(prisma.homepageSection.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { kind: HomepageSectionKind.BANNERS },
        }),
      );
    });

    it('defaults position to 0 and enabled to true on create', async () => {
      prisma.homepageSection.upsert.mockResolvedValue(sectionRow());

      await service.upsert({ kind: HomepageSectionKind.CATEGORIES });

      const call = prisma.homepageSection.upsert.mock.calls[0] as unknown[];
      const arg = call[0] as { create: Record<string, unknown> };
      expect(arg.create.position).toBe(0);
      expect(arg.create.enabled).toBe(true);
    });

    it('includes config in the update when provided', async () => {
      prisma.homepageSection.upsert.mockResolvedValue(sectionRow());

      await service.upsert({
        kind: HomepageSectionKind.FEATURED,
        config: { limit: 6 },
      });

      const call = prisma.homepageSection.upsert.mock.calls[0] as unknown[];
      const arg = call[0] as { update: Record<string, unknown> };
      expect(arg.update.config).toEqual({ limit: 6 });
    });

    it('does not include title in update when not provided', async () => {
      prisma.homepageSection.upsert.mockResolvedValue(sectionRow());

      await service.upsert({ kind: HomepageSectionKind.OFFERS });

      const call = prisma.homepageSection.upsert.mock.calls[0] as unknown[];
      const arg = call[0] as { update: Record<string, unknown> };
      expect(arg.update.title).toBeUndefined();
    });
  });

  describe('remove', () => {
    it('deletes a section by id', async () => {
      prisma.homepageSection.findUnique.mockResolvedValue(sectionRow());
      prisma.homepageSection.delete.mockResolvedValue(sectionRow());

      await service.remove('sec-1');

      expect(prisma.homepageSection.delete).toHaveBeenCalledWith({
        where: { id: 'sec-1' },
      });
    });

    it('throws NotFoundException when section does not exist', async () => {
      prisma.homepageSection.findUnique.mockResolvedValue(null);

      await expect(service.remove('missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('reorder', () => {
    it('updates positions in a transaction and returns refreshed list', async () => {
      const ids = ['s-1', 's-2', 's-3'];
      prisma.$transaction.mockResolvedValue([]);
      prisma.homepageSection.findMany.mockResolvedValue(
        ids.map((id, i) => sectionRow({ id, position: i })),
      );

      const result = await service.reorder({ sectionIds: ids });

      const txArg = prisma.$transaction.mock.calls[0] as unknown[][];
      expect(txArg[0]).toHaveLength(3);
      expect(prisma.homepageSection.update).toHaveBeenCalledTimes(3);
      expect(prisma.homepageSection.update).toHaveBeenCalledWith({
        where: { id: 's-1' },
        data: { position: 0 },
      });
      expect(prisma.homepageSection.update).toHaveBeenCalledWith({
        where: { id: 's-3' },
        data: { position: 2 },
      });
      expect(result).toHaveLength(3);
    });
  });
});
