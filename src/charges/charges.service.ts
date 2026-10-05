import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { ChargeContext, ChargeRecord, evaluateCharges } from './charge-evaluation';
import { CreateChargeDto, UpdateChargeDto } from './dto/charge.dto';

const chargeSelect = {
  id: true,
  name: true,
  nameAr: true,
  type: true,
  appliesTo: true,
  amountMinor: true,
  percentBps: true,
  taxable: true,
  taxClass: true,
  branchIds: true,
  conditions: true,
  priority: true,
  startsAt: true,
  endsAt: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ChargeSelect;

@Injectable()
export class ChargesService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    return this.prisma.charge.findMany({
      select: chargeSelect,
      orderBy: [{ priority: 'asc' }, { name: 'asc' }],
    });
  }

  async findById(id: string) {
    const charge = await this.prisma.charge.findUnique({
      where: { id },
      select: chargeSelect,
    });
    if (!charge) throw new NotFoundException('Charge not found.');
    return charge;
  }

  async create(dto: CreateChargeDto) {
    return this.prisma.charge.create({
      data: {
        name: dto.name,
        nameAr: dto.nameAr,
        type: dto.type,
        appliesTo: dto.appliesTo,
        amountMinor: dto.amountMinor,
        percentBps: dto.percentBps,
        taxable: dto.taxable,
        taxClass: dto.taxClass,
        branchIds: dto.branchIds ?? Prisma.JsonNull,
        conditions: dto.conditions
          ? (dto.conditions as unknown as Prisma.JsonObject)
          : Prisma.JsonNull,
        priority: dto.priority,
        startsAt: dto.startsAt ? new Date(dto.startsAt) : undefined,
        endsAt: dto.endsAt ? new Date(dto.endsAt) : undefined,
        isActive: dto.isActive,
      },
      select: chargeSelect,
    });
  }

  async update(id: string, dto: UpdateChargeDto) {
    await this.findById(id);

    const data: Prisma.ChargeUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.nameAr !== undefined) data.nameAr = dto.nameAr;
    if (dto.type !== undefined) data.type = dto.type;
    if (dto.appliesTo !== undefined) data.appliesTo = dto.appliesTo;
    if (dto.amountMinor !== undefined) data.amountMinor = dto.amountMinor;
    if (dto.percentBps !== undefined) data.percentBps = dto.percentBps;
    if (dto.taxable !== undefined) data.taxable = dto.taxable;
    if (dto.taxClass !== undefined) data.taxClass = dto.taxClass;
    if (dto.branchIds !== undefined) data.branchIds = dto.branchIds ?? Prisma.JsonNull;
    if (dto.conditions !== undefined) {
      data.conditions = dto.conditions
        ? (dto.conditions as unknown as Prisma.JsonObject)
        : Prisma.JsonNull;
    }
    if (dto.priority !== undefined) data.priority = dto.priority;
    if (dto.startsAt !== undefined) data.startsAt = dto.startsAt ? new Date(dto.startsAt) : null;
    if (dto.endsAt !== undefined) data.endsAt = dto.endsAt ? new Date(dto.endsAt) : null;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    return this.prisma.charge.update({
      where: { id },
      data,
      select: chargeSelect,
    });
  }

  async resolveForOrder(ctx: ChargeContext) {
    const allCharges = await this.prisma.charge.findMany({
      where: { isActive: true },
      select: chargeSelect,
    });

    const records: ChargeRecord[] = allCharges.map((c) => ({
      id: c.id,
      name: c.name,
      nameAr: c.nameAr,
      type: c.type,
      appliesTo: c.appliesTo,
      amountMinor: c.amountMinor,
      percentBps: c.percentBps,
      taxable: c.taxable,
      taxClass: c.taxClass,
      branchIds: c.branchIds as string[] | null,
      conditions: c.conditions as ChargeRecord['conditions'],
      priority: c.priority,
      startsAt: c.startsAt,
      endsAt: c.endsAt,
      isActive: c.isActive,
    }));

    return evaluateCharges(records, ctx);
  }
}
