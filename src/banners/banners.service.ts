import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { CreateBannerDto, UpdateBannerDto } from './dto/banner.dto';

@Injectable()
export class BannersService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    return this.prisma.banner.findMany({
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
    });
  }

  async findById(id: string) {
    const banner = await this.prisma.banner.findUnique({ where: { id } });
    if (!banner) throw new NotFoundException('Banner not found.');
    return banner;
  }

  async create(dto: CreateBannerDto) {
    return this.prisma.banner.create({
      data: {
        name: dto.name,
        imageUrl: dto.imageUrl,
        imageUrlAr: dto.imageUrlAr,
        title: dto.title,
        titleAr: dto.titleAr,
        description: dto.description,
        descriptionAr: dto.descriptionAr,
        buttonText: dto.buttonText,
        buttonTextAr: dto.buttonTextAr,
        action: dto.action,
        targetId: dto.targetId,
        targetUrl: dto.targetUrl,
        branchIds: dto.branchIds ?? [],
        priority: dto.priority ?? 0,
        startsAt: dto.startsAt ? new Date(dto.startsAt) : undefined,
        endsAt: dto.endsAt ? new Date(dto.endsAt) : undefined,
      },
    });
  }

  async update(id: string, dto: UpdateBannerDto) {
    await this.findById(id);

    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.imageUrl !== undefined) data.imageUrl = dto.imageUrl;
    if (dto.imageUrlAr !== undefined) data.imageUrlAr = dto.imageUrlAr;
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.titleAr !== undefined) data.titleAr = dto.titleAr;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.descriptionAr !== undefined) data.descriptionAr = dto.descriptionAr;
    if (dto.buttonText !== undefined) data.buttonText = dto.buttonText;
    if (dto.buttonTextAr !== undefined) data.buttonTextAr = dto.buttonTextAr;
    if (dto.action !== undefined) data.action = dto.action;
    if (dto.targetId !== undefined) data.targetId = dto.targetId;
    if (dto.targetUrl !== undefined) data.targetUrl = dto.targetUrl;
    if (dto.branchIds !== undefined) data.branchIds = dto.branchIds;
    if (dto.priority !== undefined) data.priority = dto.priority;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    if (dto.startsAt !== undefined) {
      data.startsAt = dto.startsAt === '' ? null : new Date(dto.startsAt);
    }
    if (dto.endsAt !== undefined) {
      data.endsAt = dto.endsAt === '' ? null : new Date(dto.endsAt);
    }

    return this.prisma.banner.update({ where: { id }, data });
  }

  async publish(id: string) {
    await this.findById(id);
    return this.prisma.banner.update({
      where: { id },
      data: { isActive: true, publishedAt: new Date() },
    });
  }

  async unpublish(id: string) {
    await this.findById(id);
    return this.prisma.banner.update({
      where: { id },
      data: { isActive: false },
    });
  }

  async remove(id: string) {
    await this.findById(id);
    return this.prisma.banner.delete({ where: { id } });
  }

  async listActive(branchId?: string) {
    const now = new Date();
    const banners = await this.prisma.banner.findMany({
      where: {
        isActive: true,
        OR: [{ startsAt: null }, { startsAt: { lte: now } }],
        AND: [{ OR: [{ endsAt: null }, { endsAt: { gt: now } }] }],
      },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
    });

    if (!branchId) return banners;

    return banners.filter((b) => b.branchIds.length === 0 || b.branchIds.includes(branchId));
  }
}
