import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { Actor } from '../auth/types/actor';
import { assertBranchAccess } from '../branches/branch-scope';
import { PrismaService } from '../prisma/prisma.service';
import {
  BranchDocketOverride,
  DEFAULT_DOCKET_TEMPLATE,
  DocketTemplate,
  resolveTemplate,
  withDefaults,
} from './receipt-template';

/**
 * Stores the customer-docket template and resolves the one a branch prints.
 *
 * The **default** row (`branchId` null) is the owner's, and a branch's row is
 * its partial override. A branch that has never been edited has no row at all,
 * and an organisation that has never been edited has none either — both fall
 * through to `DEFAULT_DOCKET_TEMPLATE`, so the first receipt a new branch
 * prints is the same one every other branch prints rather than a blank page.
 */
@Injectable()
export class ReceiptTemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  /** The organisation default, as edited or as shipped. */
  async organisationDefault(): Promise<{ template: DocketTemplate; updatedAt: Date | null }> {
    const row = await this.prisma.receiptTemplate.findFirst({ where: { branchId: null } });
    return { template: withDefaults(row?.config), updatedAt: row?.updatedAt ?? null };
  }

  async saveOrganisationDefault(actor: Actor, template: DocketTemplate): Promise<DocketTemplate> {
    const existing = await this.prisma.receiptTemplate.findFirst({ where: { branchId: null } });
    const config = template as unknown as Prisma.InputJsonValue;

    if (existing) {
      const saved = await this.prisma.receiptTemplate.update({
        where: { id: existing.id },
        data: { config, updatedByUserId: actor.id },
      });
      return withDefaults(saved.config);
    }

    const created = await this.prisma.receiptTemplate.create({
      data: { branchId: null, config, updatedByUserId: actor.id },
    });
    return withDefaults(created.config);
  }

  /**
   * What one branch prints: the owner's default with that branch's override on
   * top. The override is returned beside it so an editor can show what this
   * branch has changed rather than only the result.
   */
  async forBranch(
    actor: Actor,
    branchId: string,
  ): Promise<{
    resolved: DocketTemplate;
    organisationDefault: DocketTemplate;
    override: BranchDocketOverride;
  }> {
    assertBranchAccess(actor, branchId);

    const [defaultRow, branchRow] = await Promise.all([
      this.prisma.receiptTemplate.findFirst({ where: { branchId: null } }),
      this.prisma.receiptTemplate.findUnique({ where: { branchId } }),
    ]);

    return {
      resolved: resolveTemplate(defaultRow?.config, branchRow?.config),
      organisationDefault: withDefaults(defaultRow?.config),
      override: (branchRow?.config as BranchDocketOverride | undefined) ?? {},
    };
  }

  async saveBranchOverride(
    actor: Actor,
    branchId: string,
    override: BranchDocketOverride,
  ): Promise<DocketTemplate> {
    assertBranchAccess(actor, branchId);

    const config = override as unknown as Prisma.InputJsonValue;
    await this.prisma.receiptTemplate.upsert({
      where: { branchId },
      create: { branchId, config, updatedByUserId: actor.id },
      update: { config, updatedByUserId: actor.id },
    });

    const { resolved } = await this.forBranch(actor, branchId);
    return resolved;
  }

  /** Drops a branch back to the owner's template. */
  async clearBranchOverride(actor: Actor, branchId: string): Promise<DocketTemplate> {
    assertBranchAccess(actor, branchId);

    await this.prisma.receiptTemplate.deleteMany({ where: { branchId } });
    const { resolved } = await this.forBranch(actor, branchId);
    return resolved;
  }

  /** The built-in template, for a "reset to ours" button. */
  shipped(): DocketTemplate {
    return DEFAULT_DOCKET_TEMPLATE;
  }
}
