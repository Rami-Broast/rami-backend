import { NotFoundException } from '@nestjs/common';
import { BannerAction } from '@prisma/client';

import { BannersService } from '../../src/banners/banners.service';
import { PrismaService } from '../../src/prisma/prisma.service';

function mockPrisma(): { banner: Record<string, jest.Mock> } {
  return {
    banner: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };
}

function bannerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'banner-1',
    name: 'Summer Sale',
    imageUrl: 'https://cdn.example.com/summer.jpg',
    imageUrlAr: null,
    title: 'Summer Sale!',
    titleAr: null,
    description: null,
    descriptionAr: null,
    buttonText: null,
    buttonTextAr: null,
    action: BannerAction.NONE,
    targetId: null,
    targetUrl: null,
    branchIds: [],
    priority: 0,
    startsAt: null,
    endsAt: null,
    isActive: false,
    publishedAt: null,
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
}

describe('BannersService', () => {
  let service: BannersService;
  let prisma: ReturnType<typeof mockPrisma>;

  beforeEach(() => {
    prisma = mockPrisma();
    service = new BannersService(prisma as unknown as PrismaService);
  });

  describe('list', () => {
    it('returns all banners ordered by priority then createdAt desc', async () => {
      const rows = [bannerRow({ id: 'b-1' }), bannerRow({ id: 'b-2' })];
      prisma.banner.findMany.mockResolvedValue(rows);

      const result = await service.list();

      expect(result).toBe(rows);
      expect(prisma.banner.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
        }),
      );
    });
  });

  describe('findById', () => {
    it('returns a banner by ID', async () => {
      prisma.banner.findUnique.mockResolvedValue(bannerRow());
      const result = await service.findById('banner-1');
      expect(result).toEqual(bannerRow());
    });

    it('throws NotFoundException when not found', async () => {
      prisma.banner.findUnique.mockResolvedValue(null);
      await expect(service.findById('missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('creates a banner from DTO', async () => {
      prisma.banner.create.mockResolvedValue(bannerRow());

      const result = await service.create({
        name: 'Summer Sale',
        imageUrl: 'https://cdn.example.com/summer.jpg',
        title: 'Summer Sale!',
      });

      expect(result).toEqual(bannerRow());
      const call = prisma.banner.create.mock.calls[0] as unknown[];
      const arg = call[0] as { data: Record<string, unknown> };
      expect(arg.data.name).toBe('Summer Sale');
      expect(arg.data.imageUrl).toBe('https://cdn.example.com/summer.jpg');
    });

    it('converts date strings to Date objects', async () => {
      prisma.banner.create.mockResolvedValue(bannerRow());

      await service.create({
        name: 'Timed Banner',
        imageUrl: 'https://cdn.example.com/timed.jpg',
        title: 'Limited Time',
        startsAt: '2026-07-01T00:00:00Z',
        endsAt: '2026-08-01T00:00:00Z',
      });

      const call = prisma.banner.create.mock.calls[0] as unknown[];
      const arg = call[0] as { data: Record<string, unknown> };
      expect(arg.data.startsAt).toEqual(new Date('2026-07-01T00:00:00Z'));
      expect(arg.data.endsAt).toEqual(new Date('2026-08-01T00:00:00Z'));
    });
  });

  describe('update', () => {
    it('updates only provided fields', async () => {
      prisma.banner.findUnique.mockResolvedValue(bannerRow());
      prisma.banner.update.mockResolvedValue(bannerRow({ name: 'Updated' }));

      await service.update('banner-1', { name: 'Updated' });

      const call = prisma.banner.update.mock.calls[0] as unknown[];
      const arg = call[0] as { data: Record<string, unknown> };
      expect(arg.data.name).toBe('Updated');
      expect(arg.data.imageUrl).toBeUndefined();
    });

    it('throws NotFoundException when banner does not exist', async () => {
      prisma.banner.findUnique.mockResolvedValue(null);
      await expect(service.update('missing', { name: 'X' })).rejects.toThrow(NotFoundException);
    });

    it('sets startsAt to null when empty string provided', async () => {
      prisma.banner.findUnique.mockResolvedValue(bannerRow());
      prisma.banner.update.mockResolvedValue(bannerRow());

      await service.update('banner-1', { startsAt: '' });

      const call = prisma.banner.update.mock.calls[0] as unknown[];
      const arg = call[0] as { data: Record<string, unknown> };
      expect(arg.data.startsAt).toBeNull();
    });
  });

  describe('publish', () => {
    it('sets isActive to true and stamps publishedAt', async () => {
      prisma.banner.findUnique.mockResolvedValue(bannerRow());
      prisma.banner.update.mockResolvedValue(bannerRow({ isActive: true }));

      await service.publish('banner-1');

      const call = prisma.banner.update.mock.calls[0] as unknown[];
      const arg = call[0] as { data: Record<string, unknown> };
      expect(arg.data.isActive).toBe(true);
      expect(arg.data.publishedAt).toBeInstanceOf(Date);
    });
  });

  describe('unpublish', () => {
    it('sets isActive to false', async () => {
      prisma.banner.findUnique.mockResolvedValue(bannerRow({ isActive: true }));
      prisma.banner.update.mockResolvedValue(bannerRow({ isActive: false }));

      await service.unpublish('banner-1');

      const call = prisma.banner.update.mock.calls[0] as unknown[];
      const arg = call[0] as { data: Record<string, unknown> };
      expect(arg.data.isActive).toBe(false);
    });
  });

  describe('remove', () => {
    it('deletes the banner', async () => {
      prisma.banner.findUnique.mockResolvedValue(bannerRow());
      prisma.banner.delete.mockResolvedValue(bannerRow());

      await service.remove('banner-1');

      expect(prisma.banner.delete).toHaveBeenCalledWith({ where: { id: 'banner-1' } });
    });

    it('throws NotFoundException when not found', async () => {
      prisma.banner.findUnique.mockResolvedValue(null);
      await expect(service.remove('missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('listActive', () => {
    it('returns only active banners within date window', async () => {
      const active = bannerRow({ id: 'b-active', isActive: true });
      prisma.banner.findMany.mockResolvedValue([active]);

      const result = await service.listActive();

      expect(result).toHaveLength(1);
      expect(prisma.banner.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isActive: true }) as Record<string, unknown>,
        }),
      );
    });

    it('filters by branchId when provided', async () => {
      const allBranches = bannerRow({ id: 'b-all', branchIds: [], isActive: true });
      const branch1 = bannerRow({ id: 'b-1', branchIds: ['branch-1'], isActive: true });
      const branch2 = bannerRow({ id: 'b-2', branchIds: ['branch-2'], isActive: true });
      prisma.banner.findMany.mockResolvedValue([allBranches, branch1, branch2]);

      const result = await service.listActive('branch-1');

      expect(result).toHaveLength(2);
      expect(result.map((b: { id: string }) => b.id)).toEqual(['b-all', 'b-1']);
    });
  });
});
