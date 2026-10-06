import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  AttachModifierGroupDto,
  CreateAddonDto,
  CreateCategoryDto,
  CreateModifierGroupDto,
  CreateProductDto,
  CreateVariantDto,
  SetAvailabilityDto,
  UpdateAddonDto,
  UpdateCategoryDto,
  UpdateModifierGroupDto,
  UpdateProductDto,
  UpdateVariantDto,
} from './dto/menu.dto';

/**
 * Catalog management.
 *
 * The catalog itself (categories, products, prices) is organisation-wide and
 * requires `menu:write`, which only an owner holds. What a branch controls is
 * *availability* — whether it currently sells an item, and optionally at what
 * price — which requires `menu:availability` and is branch-scoped.
 *
 * That split is deliberate: a branch manager can mark the lamb off for the
 * evening without being able to rename a product or change the price the whole
 * chain charges.
 */
@Injectable()
export class MenuService {
  constructor(private readonly prisma: PrismaService) {}

  // --- Categories -----------------------------------------------------------

  listCategories(includeInactive = false) {
    return this.prisma.category.findMany({
      where: { deletedAt: null, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  createCategory(dto: CreateCategoryDto) {
    return this.prisma.category.create({ data: { ...dto } });
  }

  async updateCategory(id: string, dto: UpdateCategoryDto) {
    await this.requireCategory(id);

    return this.prisma.category.update({ where: { id }, data: { ...dto } });
  }

  /**
   * Soft-deletes a category.
   *
   * Refuses while it still holds live products: deleting a category out from
   * under them would leave products unreachable in the admin UI while still
   * sellable through a direct request.
   */
  async deleteCategory(id: string): Promise<void> {
    await this.requireCategory(id);

    const liveProducts = await this.prisma.product.count({
      where: { categoryId: id, deletedAt: null },
    });

    if (liveProducts > 0) {
      throw new BadRequestException(
        'This category still contains products. Move or remove them first.',
      );
    }

    await this.prisma.category.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  private async requireCategory(id: string) {
    const category = await this.prisma.category.findFirst({ where: { id, deletedAt: null } });

    if (!category) {
      throw new NotFoundException('Category not found.');
    }

    return category;
  }

  // --- Products -------------------------------------------------------------

  listProducts(options: { categoryId?: string; includeInactive?: boolean } = {}) {
    return this.prisma.product.findMany({
      where: {
        deletedAt: null,
        ...(options.categoryId ? { categoryId: options.categoryId } : {}),
        ...(options.includeInactive ? {} : { isActive: true }),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { variants: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } } },
    });
  }

  async getProduct(id: string) {
    const product = await this.prisma.product.findFirst({
      where: { id, deletedAt: null },
      include: {
        variants: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } },
        availability: { include: { branch: { select: { id: true, code: true, name: true } } } },
        modifierGroups: {
          where: { modifierGroup: { deletedAt: null } },
          orderBy: { sortOrder: 'asc' },
          include: {
            modifierGroup: {
              include: {
                addons: {
                  where: { deletedAt: null },
                  orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
                },
              },
            },
          },
        },
      },
    });

    if (!product) {
      throw new NotFoundException('Product not found.');
    }

    return product;
  }

  async createProduct(dto: CreateProductDto) {
    await this.requireCategory(dto.categoryId);

    try {
      return await this.prisma.product.create({ data: { ...dto } });
    } catch (error) {
      throw this.translateSkuConflict(error);
    }
  }

  async updateProduct(id: string, dto: UpdateProductDto) {
    await this.getProduct(id);

    if (dto.categoryId) {
      await this.requireCategory(dto.categoryId);
    }

    try {
      return await this.prisma.product.update({ where: { id }, data: { ...dto } });
    } catch (error) {
      throw this.translateSkuConflict(error);
    }
  }

  /**
   * Soft-deletes a product.
   *
   * Never a hard delete: order history references products, and while the order
   * line carries its own snapshot, keeping the row means historical reporting
   * can still resolve what was sold.
   */
  async deleteProduct(id: string): Promise<void> {
    await this.getProduct(id);

    await this.prisma.$transaction([
      this.prisma.product.update({
        where: { id },
        data: { deletedAt: new Date(), isActive: false },
      }),
      // Stop every branch selling it immediately, rather than relying on each
      // branch to notice.
      this.prisma.productAvailability.updateMany({
        where: { productId: id },
        data: { isAvailable: false },
      }),
    ]);
  }

  private translateSkuConflict(error: unknown): unknown {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      return error;
    }

    // Prisma reports the conflicting columns as a string array, but the field
    // is loosely typed. Narrow it rather than stringifying an unknown shape.
    const target: unknown = error.meta?.target;
    const columns = Array.isArray(target)
      ? target.filter((column): column is string => typeof column === 'string')
      : typeof target === 'string'
        ? [target]
        : [];

    if (columns.some((column) => column.includes('sku'))) {
      return new BadRequestException('That SKU is already in use.');
    }

    return error;
  }

  // --- Per-branch availability ---------------------------------------------

  /**
   * Sets whether a branch sells a product, and at what price.
   *
   * Branch-scoped: the caller's access to `branchId` is checked by
   * `BranchAccessGuard` before this runs.
   */
  async setAvailability(branchId: string, productId: string, dto: SetAvailabilityDto) {
    const [branch, product] = await Promise.all([
      this.prisma.branch.findFirst({ where: { id: branchId, deletedAt: null } }),
      this.prisma.product.findFirst({ where: { id: productId, deletedAt: null } }),
    ]);

    if (!branch) {
      throw new NotFoundException('Branch not found.');
    }

    if (!product) {
      throw new NotFoundException('Product not found.');
    }

    const unavailableUntil = dto.unavailableUntil ? new Date(dto.unavailableUntil) : null;

    if (unavailableUntil !== null && Number.isNaN(unavailableUntil.getTime())) {
      throw new BadRequestException('unavailableUntil must be a valid date.');
    }

    // A PATCH updates what it sends. `priceOverrideMinor: dto.x ?? null` would
    // wipe the branch's price whenever the field is merely absent — and the
    // Branch POS sold-out toggle sends nothing but `isAvailable`, so marking
    // one item out of stock silently erased that branch's price for it. An
    // explicit `null` still clears it, which is how a price override is meant
    // to be removed; omitting the field now leaves it alone.
    const touchesPrice = 'priceOverrideMinor' in dto && dto.priceOverrideMinor !== undefined;

    const update = {
      isAvailable: dto.isAvailable,
      // A stock-out window only means anything while the item is off. Clearing
      // it when the item comes back is load-bearing: the availability rule lets
      // a window outrank the flag, so a stale window would keep an item off
      // after someone had switched it on.
      unavailableUntil: dto.isAvailable ? null : unavailableUntil,
      ...(touchesPrice ? { priceOverrideMinor: dto.priceOverrideMinor ?? null } : {}),
    };

    return this.prisma.productAvailability.upsert({
      where: { productId_branchId: { productId, branchId } },
      update,
      create: {
        productId,
        branchId,
        ...update,
        priceOverrideMinor: dto.priceOverrideMinor ?? null,
      },
    });
  }

  listAvailability(branchId: string) {
    return this.prisma.productAvailability.findMany({
      where: { branchId, product: { deletedAt: null } },
      include: {
        product: {
          select: { id: true, name: true, sku: true, basePriceMinor: true, isActive: true },
        },
      },
      orderBy: { product: { name: 'asc' } },
    });
  }

  // --- Variants -------------------------------------------------------------
  //
  // A variant carries an absolute price that replaces the product's base price
  // (see the schema comment on ProductVariant). At most one variant per product
  // is the default; setting one clears the others in the same transaction so
  // the invariant can never be broken by two concurrent writes.

  async createVariant(productId: string, dto: CreateVariantDto) {
    await this.getProduct(productId);

    try {
      return await this.prisma.$transaction(async (tx) => {
        if (dto.isDefault) {
          await tx.productVariant.updateMany({
            where: { productId, deletedAt: null, isDefault: true },
            data: { isDefault: false },
          });
        }

        return tx.productVariant.create({ data: { productId, ...dto } });
      });
    } catch (error) {
      throw this.translateSkuConflict(error);
    }
  }

  async updateVariant(id: string, dto: UpdateVariantDto) {
    const variant = await this.requireVariant(id);

    try {
      return await this.prisma.$transaction(async (tx) => {
        if (dto.isDefault) {
          await tx.productVariant.updateMany({
            where: {
              productId: variant.productId,
              deletedAt: null,
              isDefault: true,
              id: { not: id },
            },
            data: { isDefault: false },
          });
        }

        return tx.productVariant.update({ where: { id }, data: { ...dto } });
      });
    } catch (error) {
      throw this.translateSkuConflict(error);
    }
  }

  /** Soft-deletes a variant. Past orders keep their own price snapshot. */
  async deleteVariant(id: string): Promise<void> {
    await this.requireVariant(id);

    await this.prisma.productVariant.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false, isDefault: false },
    });
  }

  private async requireVariant(id: string) {
    const variant = await this.prisma.productVariant.findFirst({ where: { id, deletedAt: null } });

    if (!variant) {
      throw new NotFoundException('Variant not found.');
    }

    return variant;
  }

  // --- Modifier groups ------------------------------------------------------
  //
  // A modifier group ("Choose your sauce") is a reusable set of add-ons shared
  // across products through ProductModifierGroup. It is organisation-wide
  // catalog, so it lives behind `menu:write`.

  listModifierGroups(includeInactive = false) {
    return this.prisma.modifierGroup.findMany({
      where: { deletedAt: null, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: { name: 'asc' },
      include: {
        addons: {
          where: { deletedAt: null },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        },
      },
    });
  }

  createModifierGroup(dto: CreateModifierGroupDto) {
    this.assertSelectionBounds(dto.minSelections, dto.maxSelections);

    return this.prisma.modifierGroup.create({ data: { ...dto } });
  }

  async updateModifierGroup(id: string, dto: UpdateModifierGroupDto) {
    const group = await this.requireModifierGroup(id);

    // Validate the resulting bounds, merging the change onto the stored values
    // so a partial update can never leave min above max.
    this.assertSelectionBounds(
      dto.minSelections ?? group.minSelections,
      dto.maxSelections ?? group.maxSelections,
    );

    return this.prisma.modifierGroup.update({ where: { id }, data: { ...dto } });
  }

  /**
   * Soft-deletes a modifier group and detaches it from every product in one
   * transaction. Unlike a category, a modifier group is a shared building
   * block, so refusing to delete it until it is manually removed from each
   * product would be tedious; removing the links here is the kinder, still-safe
   * choice. Order history is untouched — it references Addon rows through
   * OrderItemModifier, not this group.
   */
  async deleteModifierGroup(id: string): Promise<void> {
    await this.requireModifierGroup(id);

    await this.prisma.$transaction([
      this.prisma.productModifierGroup.deleteMany({ where: { modifierGroupId: id } }),
      this.prisma.modifierGroup.update({
        where: { id },
        data: { deletedAt: new Date(), isActive: false },
      }),
    ]);
  }

  private assertSelectionBounds(min = 0, max = 1) {
    if (max < 1) {
      throw new BadRequestException('maxSelections must be at least 1.');
    }

    if (min > max) {
      throw new BadRequestException('minSelections cannot exceed maxSelections.');
    }
  }

  private async requireModifierGroup(id: string) {
    const group = await this.prisma.modifierGroup.findFirst({ where: { id, deletedAt: null } });

    if (!group) {
      throw new NotFoundException('Modifier group not found.');
    }

    return group;
  }

  // --- Add-ons --------------------------------------------------------------

  async createAddon(modifierGroupId: string, dto: CreateAddonDto) {
    await this.requireModifierGroup(modifierGroupId);

    return this.prisma.addon.create({ data: { modifierGroupId, ...dto } });
  }

  async updateAddon(id: string, dto: UpdateAddonDto) {
    await this.requireAddon(id);

    return this.prisma.addon.update({ where: { id }, data: { ...dto } });
  }

  /** Soft-deletes an add-on. Past order modifiers keep their own snapshot. */
  async deleteAddon(id: string): Promise<void> {
    await this.requireAddon(id);

    await this.prisma.addon.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  private async requireAddon(id: string) {
    const addon = await this.prisma.addon.findFirst({ where: { id, deletedAt: null } });

    if (!addon) {
      throw new NotFoundException('Add-on not found.');
    }

    return addon;
  }

  // --- Attaching modifier groups to products --------------------------------

  async attachModifierGroup(productId: string, dto: AttachModifierGroupDto) {
    await this.getProduct(productId);
    await this.requireModifierGroup(dto.modifierGroupId);

    return this.prisma.productModifierGroup.upsert({
      where: {
        productId_modifierGroupId: { productId, modifierGroupId: dto.modifierGroupId },
      },
      update: { sortOrder: dto.sortOrder ?? 0 },
      create: { productId, modifierGroupId: dto.modifierGroupId, sortOrder: dto.sortOrder ?? 0 },
    });
  }

  async detachModifierGroup(productId: string, modifierGroupId: string): Promise<void> {
    const link = await this.prisma.productModifierGroup.findUnique({
      where: { productId_modifierGroupId: { productId, modifierGroupId } },
    });

    if (!link) {
      throw new NotFoundException('That modifier group is not attached to this product.');
    }

    await this.prisma.productModifierGroup.delete({
      where: { productId_modifierGroupId: { productId, modifierGroupId } },
    });
  }
}
