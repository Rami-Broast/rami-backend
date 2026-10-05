import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BranchStatus, Prisma } from '@prisma/client';

import { AUDIT_ACTIONS, AUDIT_ENTITIES } from '../audit/audit-actions';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { PasswordService } from '../auth/services/password.service';
import { ActorKind, type Actor } from '../auth/types/actor';
import { PrismaService } from '../prisma/prisma.service';
import { ZatcaInvoicingService } from '../zatca-invoicing/zatca-invoicing.service';
import {
  ChangeBranchStatusDto,
  CreateBranchDto,
  DeleteBranchDto,
  DuplicateBranchDto,
  UpdateBranchDto,
} from './dto/branch.dto';

const branchSelect = {
  id: true,
  code: true,
  name: true,
  nameAr: true,
  phone: true,
  addressLine: true,
  district: true,
  city: true,
  latitude: true,
  longitude: true,
  isActive: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} satisfies Prisma.BranchSelect;

function isActiveFromStatus(status: BranchStatus): boolean {
  return status === BranchStatus.ACTIVE;
}

@Injectable()
export class BranchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly zatca: ZatcaInvoicingService,
    private readonly audit: AuditRecorder,
  ) {}

  async list() {
    return this.prisma.branch.findMany({
      where: { deletedAt: null },
      select: branchSelect,
      orderBy: { name: 'asc' },
    });
  }

  async findById(id: string) {
    const branch = await this.prisma.branch.findFirst({
      where: { id, deletedAt: null },
      select: branchSelect,
    });
    if (!branch) throw new NotFoundException('Branch not found.');
    return branch;
  }

  async create(dto: CreateBranchDto) {
    try {
      const branch = await this.prisma.branch.create({
        data: {
          code: dto.code,
          name: dto.name,
          nameAr: dto.nameAr,
          phone: dto.phone,
          addressLine: dto.addressLine,
          district: dto.district,
          city: dto.city,
          latitude: dto.latitude,
          longitude: dto.longitude,
          status: BranchStatus.ACTIVE,
          isActive: true,
          settings: { create: {} },
        },
        select: branchSelect,
      });
      // Register the new branch as its own ZATCA licence/chain (no-op unless
      // ZATCA invoicing is enabled). Best-effort — never fails branch creation.
      await this.zatca.provisionBranchById(branch.id);
      await this.audit.record({
        action: AUDIT_ACTIONS.BRANCH_CREATE,
        entityType: AUDIT_ENTITIES.BRANCH,
        entityId: branch.id,
        branchId: branch.id,
        after: { code: branch.code, name: branch.name, status: branch.status },
      });
      return branch;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`A branch with code "${dto.code}" already exists.`);
      }
      throw error;
    }
  }

  async update(id: string, dto: UpdateBranchDto) {
    const before = await this.findById(id);

    const data: Prisma.BranchUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.nameAr !== undefined) data.nameAr = dto.nameAr;
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.addressLine !== undefined) data.addressLine = dto.addressLine;
    if (dto.district !== undefined) data.district = dto.district;
    if (dto.city !== undefined) data.city = dto.city;
    if (dto.latitude !== undefined) data.latitude = dto.latitude;
    if (dto.longitude !== undefined) data.longitude = dto.longitude;

    const updated = await this.prisma.branch.update({
      where: { id },
      data,
      select: branchSelect,
    });

    await this.audit.record({
      action: AUDIT_ACTIONS.BRANCH_UPDATE,
      entityType: AUDIT_ENTITIES.BRANCH,
      entityId: id,
      branchId: id,
      before: { name: before.name, phone: before.phone, city: before.city },
      after: { name: updated.name, phone: updated.phone, city: updated.city },
    });

    return updated;
  }

  async changeStatus(id: string, dto: ChangeBranchStatusDto) {
    const before = await this.findById(id);

    const updated = await this.prisma.branch.update({
      where: { id },
      data: {
        status: dto.status,
        isActive: isActiveFromStatus(dto.status),
      },
      select: branchSelect,
    });

    await this.audit.record({
      action: AUDIT_ACTIONS.BRANCH_STATUS_CHANGE,
      entityType: AUDIT_ENTITIES.BRANCH,
      entityId: id,
      branchId: id,
      before: { status: before.status, isActive: before.isActive },
      after: { status: updated.status, isActive: updated.isActive },
    });

    return updated;
  }

  /**
   * Deletes a branch, for good, after proving the operator meant it.
   *
   * ## Why this is two different operations
   *
   * A branch is not a standalone row. It owns orders, payments, settlements,
   * deliveries and audit entries, and those are the records the restaurant's
   * revenue, VAT position and reports are reconstructed from. Actually removing
   * a branch that has traded would delete money history — which the platform's
   * own rules forbid, and which `Order.branch`'s `onDelete: Restrict` would
   * refuse at the database anyway.
   *
   * So there are two outcomes and the data decides which:
   *
   * - **A branch that has never traded is really deleted.** Zero orders, zero
   *   settlements, zero deliveries — it is a mistake someone made in the branch
   *   wizard, and leaving mistakes lying around archived is its own mess.
   * - **A branch that has traded is archived**: `ARCHIVED`, deactivated and
   *   soft-deleted, so it is gone from every list and cannot take an order,
   *   while its history stays intact for reports. The caller is told which
   *   happened, because "deleted" and "archived" are different promises and a
   *   UI that says the wrong one is lying to an owner.
   *
   * ## The two proofs
   *
   * The operator's own password, re-entered — a dialog is a speed bump, not
   * authorisation, and this endpoint is reachable without ever seeing one. And
   * the branch's code typed back, which is what makes deleting the wrong branch
   * take deliberate effort rather than one mis-aimed click.
   */
  async deleteBranch(actor: Actor, id: string, dto: DeleteBranchDto) {
    const branch = await this.findById(id);

    if (dto.code.trim().toUpperCase() !== branch.code.toUpperCase()) {
      throw new BadRequestException(
        `That is not this branch's code. Type ${branch.code} exactly to confirm.`,
      );
    }

    await this.assertOperatorPassword(actor, dto.password);

    // What the branch is carrying. Counted rather than fetched: the answer is
    // "is there any", and a branch with fifty thousand orders should not load
    // one of them.
    const [orders, settlements, deliveries, cashCollections] = await Promise.all([
      this.prisma.order.count({ where: { branchId: id } }),
      this.prisma.settlement.count({ where: { branchId: id } }),
      this.prisma.delivery.count({ where: { order: { branchId: id } } }),
      this.prisma.cashCollection.count({ where: { branchId: id } }),
    ]);
    const hasHistory = orders + settlements + deliveries + cashCollections > 0;

    if (hasHistory) {
      const archived = await this.prisma.branch.update({
        where: { id },
        data: {
          status: BranchStatus.ARCHIVED,
          isActive: false,
          // Soft delete: it leaves every staff and customer list, while its
          // orders stay where the reports can still find them.
          deletedAt: new Date(),
        },
        select: branchSelect,
      });
      await this.audit.record({
        action: AUDIT_ACTIONS.BRANCH_DELETE,
        entityType: AUDIT_ENTITIES.BRANCH,
        entityId: id,
        branchId: id,
        before: { code: branch.code, name: branch.name, status: branch.status },
        after: { outcome: 'ARCHIVED', ordersRetained: orders },
        reason: 'Branch had trading history; archived rather than deleted.',
      });
      return {
        outcome: 'ARCHIVED' as const,
        branch: archived,
        reason: `This branch has ${orders} order${orders === 1 ? '' : 's'} against it, so its records were kept. It is archived: hidden everywhere and unable to take orders.`,
      };
    }

    // Never traded. Everything below hangs off the branch and means nothing
    // without it, so it goes in one transaction with the branch itself.
    await this.prisma.$transaction(async (tx) => {
      await tx.productAvailability.deleteMany({ where: { branchId: id } });
      await tx.branchOpeningHours.deleteMany({ where: { branchId: id } });
      await tx.branchHoursOverride.deleteMany({ where: { branchId: id } });
      await tx.branchSetting.deleteMany({ where: { branchId: id } });
      await tx.branchOrderSequence.deleteMany({ where: { branchId: id } });
      // Staff keep their accounts; they simply lose an assignment to a branch
      // that no longer exists. Deleting the person because their branch closed
      // would be a surprising thing for a delete-branch button to do.
      await tx.userRole.deleteMany({ where: { branchId: id } });
      await tx.driver.updateMany({ where: { branchId: id }, data: { branchId: null } });
      await tx.branch.delete({ where: { id } });
    });

    await this.audit.record({
      action: AUDIT_ACTIONS.BRANCH_DELETE,
      entityType: AUDIT_ENTITIES.BRANCH,
      entityId: id,
      branchId: id,
      before: { code: branch.code, name: branch.name, status: branch.status },
      after: { outcome: 'DELETED' },
      reason: 'Branch had never traded; removed completely.',
    });

    return {
      outcome: 'DELETED' as const,
      branch: { ...branch, deletedAt: new Date() },
      reason: 'This branch had never taken an order, so it was removed completely.',
    };
  }

  /**
   * Re-checks the signed-in operator's own password.
   *
   * Deliberately vague on failure and identical in shape whether the account is
   * a staff account or not: this is an authorisation gate on a destructive
   * action, and it should not double as a way to learn anything about accounts.
   */
  private async assertOperatorPassword(actor: Actor, password: string): Promise<void> {
    if (actor.kind !== ActorKind.Staff) {
      throw new ForbiddenException('Only a staff account can delete a branch.');
    }

    const user = await this.prisma.user.findFirst({
      where: { id: actor.id, isActive: true, deletedAt: null },
      select: { passwordHash: true },
    });

    const matches = user ? await this.passwords.verify(user.passwordHash, password) : false;
    if (!matches) {
      throw new ForbiddenException('That password is not correct.');
    }
  }

  async duplicate(sourceId: string, dto: DuplicateBranchDto) {
    const source = await this.prisma.branch.findFirst({
      where: { id: sourceId, deletedAt: null },
      include: {
        settings: true,
        availability: { select: { productId: true, isAvailable: true, priceOverrideMinor: true } },
      },
    });
    if (!source) throw new NotFoundException('Source branch not found.');

    const status = dto.activate ? BranchStatus.ACTIVE : BranchStatus.TEMPORARILY_CLOSED;

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const branch = await tx.branch.create({
          data: {
            code: dto.code,
            name: dto.name,
            nameAr: source.nameAr,
            phone: source.phone,
            addressLine: source.addressLine,
            district: source.district,
            city: source.city,
            latitude: source.latitude,
            longitude: source.longitude,
            status,
            isActive: isActiveFromStatus(status),
          },
          select: { id: true },
        });

        if (source.settings) {
          await tx.branchSetting.create({
            data: {
              branchId: branch.id,
              acceptsDelivery: source.settings.acceptsDelivery,
              acceptsPickup: source.settings.acceptsPickup,
              isAcceptingOrders: source.settings.isAcceptingOrders,
              acceptsCashOnDelivery: source.settings.acceptsCashOnDelivery,
              autoAcceptOrders: source.settings.autoAcceptOrders,
              deliveryRadiusKm: source.settings.deliveryRadiusKm,
              deliveryFeeMinor: source.settings.deliveryFeeMinor,
              minOrderMinor: source.settings.minOrderMinor,
              prepTimeMinutes: source.settings.prepTimeMinutes,
              openingHours: source.settings.openingHours ?? Prisma.JsonNull,
              timezone: source.settings.timezone,
              printerModel: source.settings.printerModel,
              printerConnection: source.settings.printerConnection,
            },
          });
        }

        if (source.availability.length > 0) {
          await tx.productAvailability.createMany({
            data: source.availability.map((a) => ({
              branchId: branch.id,
              productId: a.productId,
              isAvailable: a.isAvailable,
              priceOverrideMinor: a.priceOverrideMinor,
            })),
          });
        }

        return tx.branch.findUniqueOrThrow({
          where: { id: branch.id },
          select: branchSelect,
        });
      });

      await this.zatca.provisionBranchById(created.id);
      await this.audit.record({
        action: AUDIT_ACTIONS.BRANCH_DUPLICATE,
        entityType: AUDIT_ENTITIES.BRANCH,
        entityId: created.id,
        branchId: created.id,
        after: {
          code: created.code,
          name: created.name,
          status: created.status,
          sourceBranchId: sourceId,
        },
      });
      return created;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`A branch with code "${dto.code}" already exists.`);
      }
      throw error;
    }
  }
}
