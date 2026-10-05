import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { CreateFeatureFlagDto, UpdateFeatureFlagDto } from './dto/feature-flag.dto';

const featureFlagSelect = {
  id: true,
  key: true,
  enabled: true,
  description: true,
  updatedAt: true,
} satisfies Prisma.FeatureFlagSelect;

@Injectable()
export class FeatureFlagsService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    return this.prisma.featureFlag.findMany({
      select: featureFlagSelect,
      orderBy: { key: 'asc' },
    });
  }

  async findByKey(key: string) {
    const flag = await this.prisma.featureFlag.findUnique({
      where: { key },
      select: featureFlagSelect,
    });
    if (!flag) throw new NotFoundException(`Feature flag "${key}" not found.`);
    return flag;
  }

  async create(dto: CreateFeatureFlagDto, actorUserId: string) {
    try {
      return await this.prisma.featureFlag.create({
        data: {
          key: dto.key,
          enabled: dto.enabled,
          description: dto.description,
          updatedByUserId: actorUserId,
        },
        select: featureFlagSelect,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`Feature flag "${dto.key}" already exists.`);
      }
      throw error;
    }
  }

  async update(key: string, dto: UpdateFeatureFlagDto, actorUserId: string) {
    await this.findByKey(key);

    const updated = await this.prisma.$transaction(async (tx) => {
      const flag = await tx.featureFlag.update({
        where: { key },
        data: { enabled: dto.enabled, updatedByUserId: actorUserId },
        select: featureFlagSelect,
      });

      await this.bumpConfigVersion(tx);

      return flag;
    });

    return updated;
  }

  async getEnabledMap(): Promise<Record<string, boolean>> {
    const flags = await this.prisma.featureFlag.findMany({
      select: { key: true, enabled: true },
    });
    const map: Record<string, boolean> = {};
    for (const f of flags) {
      map[f.key] = f.enabled;
    }
    return map;
  }

  async bumpConfigVersion(tx: Prisma.TransactionClient) {
    await tx.configVersion.upsert({
      where: { singletonKey: 'config' },
      create: { singletonKey: 'config', version: 1 },
      update: { version: { increment: 1 } },
    });
  }

  async getConfigVersion(): Promise<number> {
    const row = await this.prisma.configVersion.findUnique({
      where: { singletonKey: 'config' },
    });
    return row?.version ?? 0;
  }
}
