import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { ReorderHomepageDto, UpsertHomepageSectionDto } from './dto/homepage.dto';

@Injectable()
export class HomepageService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    return this.prisma.homepageSection.findMany({
      orderBy: { position: 'asc' },
    });
  }

  async listEnabled() {
    return this.prisma.homepageSection.findMany({
      where: { enabled: true },
      orderBy: { position: 'asc' },
    });
  }

  async upsert(dto: UpsertHomepageSectionDto) {
    const config = dto.config as Prisma.InputJsonValue | undefined;
    return this.prisma.homepageSection.upsert({
      where: { kind: dto.kind },
      create: {
        kind: dto.kind,
        title: dto.title,
        titleAr: dto.titleAr,
        position: dto.position ?? 0,
        enabled: dto.enabled ?? true,
        config: config ?? Prisma.JsonNull,
      },
      update: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.titleAr !== undefined && { titleAr: dto.titleAr }),
        ...(dto.position !== undefined && { position: dto.position }),
        ...(dto.enabled !== undefined && { enabled: dto.enabled }),
        ...(dto.config !== undefined && { config }),
      },
    });
  }

  async remove(id: string) {
    const section = await this.prisma.homepageSection.findUnique({ where: { id } });
    if (!section) throw new NotFoundException('Homepage section not found.');
    return this.prisma.homepageSection.delete({ where: { id } });
  }

  async reorder(dto: ReorderHomepageDto) {
    await this.prisma.$transaction(
      dto.sectionIds.map((id, index) =>
        this.prisma.homepageSection.update({
          where: { id },
          data: { position: index },
        }),
      ),
    );
    return this.list();
  }
}
