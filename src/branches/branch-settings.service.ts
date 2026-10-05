import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AUDIT_ACTIONS, AUDIT_ENTITIES } from '../audit/audit-actions';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateBranchSettingsDto } from './dto/branch-settings.dto';

const settingsView = {
  acceptsDelivery: true,
  acceptsPickup: true,
  isAcceptingOrders: true,
  acceptsCashOnDelivery: true,
  autoAcceptOrders: true,
  deliveryFeeMinor: true,
  deliveryBaseFeeCoversKm: true,
  deliveryPerKmFeeMinor: true,
  deliveryRoadFactor: true,
  deliveryUpliftPercent: true,
  minOrderMinor: true,
  deliveryRadiusKm: true,
  prepTimeMinutes: true,
  printerModel: true,
  printerConnection: true,
  updatedAt: true,
} satisfies Prisma.BranchSettingSelect;

/**
 * Branch operating settings — read and update.
 *
 * This is where an admin turns delivery or pickup on and off for a branch.
 * Branch isolation is enforced by the controller's `@BranchScoped('branchId')`
 * guard before any method here runs, so this service trusts the branch id.
 */
@Injectable()
export class BranchSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditRecorder,
  ) {}

  async get(branchId: string) {
    const settings = await this.prisma.branchSetting.findUnique({
      where: { branchId },
      select: settingsView,
    });
    if (!settings) {
      throw new NotFoundException('Branch settings not found.');
    }
    return settings;
  }

  /** Updates only the provided fields. Creates the row if a branch has none yet. */
  async update(branchId: string, dto: UpdateBranchSettingsDto) {
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, deletedAt: null },
      select: { id: true },
    });
    if (!branch) {
      throw new NotFoundException('Branch not found.');
    }

    // Snapshot only the fields this request is changing, both before and after,
    // so the audit row reads as "what was touched" rather than a full dump — and
    // so a delivery radius that quietly failed to save is visible after the fact.
    const changedKeys = Object.keys(dto) as (keyof UpdateBranchSettingsDto)[];
    const existing = await this.prisma.branchSetting.findUnique({
      where: { branchId },
      select: settingsView,
    });

    const updated = await this.prisma.branchSetting.upsert({
      where: { branchId },
      update: { ...dto },
      create: { branchId, ...dto },
      select: settingsView,
    });

    const pick = (source: Record<string, unknown> | null): Record<string, unknown> =>
      source ? Object.fromEntries(changedKeys.map((key) => [key, source[key]])) : {};

    await this.audit.record({
      action: AUDIT_ACTIONS.BRANCH_SETTINGS_UPDATE,
      entityType: AUDIT_ENTITIES.BRANCH_SETTING,
      entityId: branchId,
      branchId,
      before: pick(existing),
      after: pick(updated),
    });

    return updated;
  }
}
