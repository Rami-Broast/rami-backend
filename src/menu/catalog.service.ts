import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { OrderType } from '@prisma/client';

import {
  applyDeliveryUplift,
  DeliveryPricingRules,
  DeliveryQuote,
  deliveryDistanceKm,
  MaybeGeoPoint,
  priceDelivery,
  upliftPercentFor,
} from '../delivery-pricing/delivery-pricing';
import { BranchHoursService } from '../branches/branch-hours.service';
import { BranchOpenState, acceptsOrdersNow, formatMinute } from '../branches/opening-hours';
import { PrismaService } from '../prisma/prisma.service';
import { ResolvedAddon, ResolvedLine } from '../vat/pricing.types';
import { CartItemDto } from './dto/menu.dto';
import { isProductAvailable } from './product-availability';

/** The branch delivery-rule columns, as stored. Decimals arrive as Prisma.Decimal. */
type StoredDeliveryRules = {
  deliveryFeeMinor: number;
  deliveryBaseFeeCoversKm: { toNumber(): number };
  deliveryPerKmFeeMinor: number;
  deliveryRoadFactor: { toNumber(): number };
  deliveryUpliftPercent: { toNumber(): number };
  minOrderMinor: number;
  deliveryRadiusKm: { toNumber(): number } | null;
};

/**
 * The rules a branch has no settings row for.
 *
 * A branch with no row has never been configured. Charging it the owner's
 * defaults would invent a fee for a branch nobody has set up; charging nothing
 * and imposing no minimum is the honest reading, and the admin panel is where
 * the owner fixes it.
 */
const UNCONFIGURED_BRANCH_RULES: DeliveryPricingRules = {
  baseFeeMinor: 0,
  baseFeeCoversKm: 0,
  perKmFeeMinor: 0,
  maxRadiusKm: null,
  roadFactor: 1,
  minOrderMinor: 0,
};

function toRules(stored: StoredDeliveryRules | null | undefined): DeliveryPricingRules {
  if (!stored) {
    return UNCONFIGURED_BRANCH_RULES;
  }

  return {
    baseFeeMinor: stored.deliveryFeeMinor,
    baseFeeCoversKm: stored.deliveryBaseFeeCoversKm.toNumber(),
    perKmFeeMinor: stored.deliveryPerKmFeeMinor,
    maxRadiusKm: stored.deliveryRadiusKm === null ? null : stored.deliveryRadiusKm.toNumber(),
    roadFactor: stored.deliveryRoadFactor.toNumber(),
    minOrderMinor: stored.minOrderMinor,
  };
}

/** The columns `toRules` needs. Kept next to it so the two cannot drift. */
const deliveryRuleColumns = {
  deliveryFeeMinor: true,
  deliveryBaseFeeCoversKm: true,
  deliveryPerKmFeeMinor: true,
  deliveryRoadFactor: true,
  deliveryUpliftPercent: true,
  minOrderMinor: true,
  deliveryRadiusKm: true,
} as const;

/**
 * Reads the catalog as a customer sees it, for one branch.
 *
 * This is the bridge between the catalog (Phase 6) and pricing (Phase 7). Its
 * job is to turn "what the client asked for" into "what the server says those
 * things cost" — which is why a cart request carries product IDs and quantities
 * and never a price. A client that invents a price changes nothing.
 */
@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hours: BranchHoursService,
  ) {}

  /**
   * The public list of active branches a customer can order from.
   *
   * Public information — the same as a branch's address and hours printed on a
   * shopfront. Exposes only what a customer needs to choose where to order from
   * and what that branch offers; no internal settings leak.
   */
  async listBranches() {
    const branches = await this.prisma.branch.findMany({
      where: { isActive: true, deletedAt: null },
      orderBy: [{ name: 'asc' }],
      select: {
        id: true,
        name: true,
        nameAr: true,
        // The branch's own published number. A customer with a question about
        // an order needs to be able to ring the branch, and this is the list
        // the app builds that from — it is a business contact, not personal
        // data, and it is already printed on the docket.
        phone: true,
        addressLine: true,
        district: true,
        city: true,
        latitude: true,
        longitude: true,
        settings: {
          select: {
            acceptsDelivery: true,
            acceptsPickup: true,
            isAcceptingOrders: true,
            acceptsCashOnDelivery: true,
            deliveryFeeMinor: true,
            minOrderMinor: true,
            prepTimeMinutes: true,
          },
        },
      },
    });

    // Open/closed for every branch in three queries rather than four per
    // branch: this is the first list a customer's app fetches, and the page
    // they open before anything else.
    const openStates = await this.hours.openStates(branches.map((b) => b.id));

    return branches.map((branch) => ({
      id: branch.id,
      name: branch.name,
      nameAr: branch.nameAr,
      phone: branch.phone,
      addressLine: branch.addressLine,
      district: branch.district,
      city: branch.city,
      latitude: branch.latitude ? branch.latitude.toNumber() : null,
      longitude: branch.longitude ? branch.longitude.toNumber() : null,
      acceptsDelivery: branch.settings?.acceptsDelivery ?? false,
      acceptsPickup: branch.settings?.acceptsPickup ?? false,
      isAcceptingOrders: branch.settings?.isAcceptingOrders ?? false,
      acceptsCashOnDelivery: branch.settings?.acceptsCashOnDelivery ?? false,
      deliveryFeeMinor: branch.settings?.deliveryFeeMinor ?? 0,
      minOrderMinor: branch.settings?.minOrderMinor ?? 0,
      prepTimeMinutes: branch.settings?.prepTimeMinutes ?? null,
      /**
       * Whether the branch is open **right now**, by its own schedule and its
       * own timezone.
       *
       * Distinct from `isAcceptingOrders`, which is a switch someone flips.
       * This is the schedule running on its own, which is the point of having
       * one — an owner should not have to remember to close the shop every
       * night. A branch nobody has set hours for reports open, because an
       * empty schedule means unrestricted rather than closed (see
       * `branches/opening-hours.ts`); every branch predates the editor, so the
       * other reading would have shut the whole business.
       */
      ...openStateFields(openStates.get(branch.id)),
    }));
  }

  /** The menu for one branch: active categories, with the products it sells. */
  async menuForBranch(branchId: string) {
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, isActive: true, deletedAt: null },
      select: { id: true, name: true, nameAr: true, settings: true },
    });

    if (!branch) {
      throw new NotFoundException('Branch not found.');
    }

    const categories = await this.prisma.category.findMany({
      where: { isActive: true, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        products: {
          where: {
            isActive: true,
            deletedAt: null,
          },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          include: {
            variants: {
              where: { isActive: true, deletedAt: null },
              orderBy: { sortOrder: 'asc' },
            },
            availability: { where: { branchId } },
            modifierGroups: {
              include: {
                modifierGroup: {
                  include: {
                    addons: {
                      where: { isActive: true, deletedAt: null },
                      orderBy: { sortOrder: 'asc' },
                    },
                  },
                },
              },
              orderBy: { sortOrder: 'asc' },
            },
          },
        },
      },
    });

    const now = Date.now();
    const rules = toRules(branch.settings);
    const branchUplift = branch.settings?.deliveryUpliftPercent.toNumber() ?? 0;

    return {
      branch: { id: branch.id, name: branch.name, nameAr: branch.nameAr },
      // The base fee only. What a given customer pays depends on their
      // distance, which this endpoint does not know — POST /customer/orders/quote
      // is what returns the real fee.
      deliveryFeeMinor: rules.baseFeeMinor,
      minOrderMinor: rules.minOrderMinor,
      deliveryPricing: {
        baseFeeMinor: rules.baseFeeMinor,
        baseFeeCoversKm: rules.baseFeeCoversKm,
        perKmFeeMinor: rules.perKmFeeMinor,
        maxRadiusKm: rules.maxRadiusKm,
        minOrderMinor: rules.minOrderMinor,
        upliftPercent: branchUplift,
      },
      categories: categories
        .map((category) => ({
          id: category.id,
          name: category.name,
          nameAr: category.nameAr,
          imageUrl: category.imageUrl,
          products: category.products.map((product) => {
            const availability = product.availability[0];
            const isAvailable = isProductAvailable(availability, now);
            const pickupPrice = availability?.priceOverrideMinor ?? product.basePriceMinor;
            const uplift = upliftPercentFor(
              product.deliveryUpliftPercent?.toNumber() ?? null,
              branchUplift,
            );

            return {
              id: product.id,
              name: product.name,
              nameAr: product.nameAr,
              description: product.description,
              imageUrl: product.imageUrl,
              priceMinor: pickupPrice,
              // The same dish costs more on a delivery order, by the branch's
              // uplift or this product's own override. Both prices are returned
              // so the app can switch between pickup and delivery without
              // refetching the menu — and so it never has to work one out from
              // the other, which would be a client computing a price.
              deliveryPriceMinor: applyDeliveryUplift(pickupPrice, uplift),
              taxClass: product.taxClass,
              isAvailable,
              // When a timed stock-out ends, so a client can say "back in 20
              // minutes" instead of a bare "unavailable". Null when the item is
              // on sale, or when it is off with no time promised — which is a
              // real state (the supplier failed) and not a missing value.
              unavailableUntil:
                isAvailable || !availability?.unavailableUntil
                  ? null
                  : availability.unavailableUntil.toISOString(),
              variants: product.variants.map((variant) => ({
                id: variant.id,
                name: variant.name,
                nameAr: variant.nameAr,
                priceMinor: variant.priceMinor,
                deliveryPriceMinor: applyDeliveryUplift(variant.priceMinor, uplift),
                isDefault: variant.isDefault,
              })),
              modifierGroups: product.modifierGroups.map((link) => ({
                id: link.modifierGroup.id,
                name: link.modifierGroup.name,
                nameAr: link.modifierGroup.nameAr,
                minSelections: link.modifierGroup.minSelections,
                maxSelections: link.modifierGroup.maxSelections,
                isRequired: link.modifierGroup.isRequired,
                addons: link.modifierGroup.addons.map((addon) => ({
                  id: addon.id,
                  name: addon.name,
                  nameAr: addon.nameAr,
                  priceMinor: addon.priceMinor,
                })),
              })),
            };
          }),
        }))
        .filter((category) => category.products.length > 0),
    };
  }

  /**
   * Resolves a client's cart into priced lines.
   *
   * Every price here is read from the database. Anything the client sent that
   * looks like a price is ignored, because it is never read in the first place.
   *
   * Refuses the whole cart if any item is unavailable at this branch, rather
   * than silently dropping it — a customer who checks out expecting four items
   * must not be charged for three.
   */
  async resolveCartLines(
    branchId: string,
    items: readonly CartItemDto[],
    orderType: OrderType = OrderType.PICKUP,
  ): Promise<ResolvedLine[]> {
    if (items.length === 0) {
      throw new BadRequestException('The cart is empty.');
    }

    const productIds = [...new Set(items.map((item) => item.productId))];
    const addonIds = [...new Set(items.flatMap((item) => item.addonIds ?? []))];

    const [products, addons, settings] = await Promise.all([
      this.prisma.product.findMany({
        where: { id: { in: productIds }, isActive: true, deletedAt: null },
        include: {
          variants: { where: { isActive: true, deletedAt: null } },
          availability: { where: { branchId } },
          modifierGroups: { select: { modifierGroupId: true } },
        },
      }),
      addonIds.length > 0
        ? this.prisma.addon.findMany({
            where: { id: { in: addonIds }, isActive: true, deletedAt: null },
            include: { modifierGroup: { select: { id: true, name: true } } },
          })
        : Promise.resolve([]),
      this.prisma.branchSetting.findUnique({
        where: { branchId },
        select: { deliveryUpliftPercent: true },
      }),
    ]);

    const productsById = new Map(products.map((product) => [product.id, product]));
    const addonsById = new Map(addons.map((addon) => [addon.id, addon]));
    const now = Date.now();

    // The uplift applies to delivery orders only, and only to the item price —
    // add-ons are not uplifted because the branch sets the uplift to cover the
    // cost of the delivery, not to mark up every extra sauce.
    const branchUplift =
      orderType === OrderType.DELIVERY ? (settings?.deliveryUpliftPercent.toNumber() ?? 0) : 0;

    return items.map((item) => {
      const product = productsById.get(item.productId);

      if (!product) {
        throw new BadRequestException('One or more items are no longer on the menu.');
      }

      const availability = product.availability[0];

      // Same rule as the branch menu, from the same function: if these two ever
      // disagree, a customer builds a basket that fails at checkout.
      if (!isProductAvailable(availability, now)) {
        throw new BadRequestException(`"${product.name}" is not available at this branch.`);
      }

      // A variant price replaces the product price; a branch override replaces
      // the catalog price. Variant wins because it is the more specific choice.
      const uplift = upliftPercentFor(
        product.deliveryUpliftPercent?.toNumber() ?? null,
        branchUplift,
      );

      let unitPriceMinor = availability?.priceOverrideMinor ?? product.basePriceMinor;
      let variantName: string | undefined;

      if (item.productVariantId) {
        const variant = product.variants.find(
          (candidate) => candidate.id === item.productVariantId,
        );

        if (!variant) {
          throw new BadRequestException('The selected option is no longer available.');
        }

        unitPriceMinor = variant.priceMinor;
        variantName = variant.name;
      }

      // Applied last, after every other price rule has chosen the base — so a
      // branch override, a variant and the uplift compose in one predictable
      // order instead of three.
      unitPriceMinor = applyDeliveryUplift(unitPriceMinor, uplift);

      const allowedGroupIds = new Set(product.modifierGroups.map((link) => link.modifierGroupId));

      const resolvedAddons: ResolvedAddon[] = (item.addonIds ?? []).map((addonId) => {
        const addon = addonsById.get(addonId);

        if (!addon) {
          throw new BadRequestException('One or more selected extras are unavailable.');
        }

        // An add-on from a group this product does not offer is rejected —
        // otherwise a crafted request could attach any add-on to any product.
        if (!allowedGroupIds.has(addon.modifierGroup.id)) {
          throw new BadRequestException('One or more selected extras do not belong to this item.');
        }

        return {
          addonId: addon.id,
          modifierGroupName: addon.modifierGroup.name,
          addonName: addon.name,
          unitPriceMinor: addon.priceMinor,
          taxClass: addon.taxClass,
          quantity: 1,
        };
      });

      return {
        productId: product.id,
        productVariantId: item.productVariantId,
        productName: product.name,
        variantName,
        unitPriceMinor,
        quantity: item.quantity,
        taxClass: product.taxClass,
        addons: resolvedAddons,
        notes: item.notes,
      };
    });
  }

  /**
   * Prices the delivery leg of an order: the distance fee, the minimum-order
   * check and the radius check, in one object.
   *
   * Returns the whole breakdown rather than a bare number so that every screen
   * that shows a total can also show how it was reached. `blockers` is
   * advisory here — this method never throws for a cart that is too small or an
   * address too far away, because a *quote* must still return the numbers that
   * explain why. {@link assertDeliverable} is what refuses a placement.
   */
  async quoteDelivery(
    branchId: string,
    type: OrderType,
    destination: MaybeGeoPoint | null | undefined,
    itemSubtotalMinor: number,
  ): Promise<DeliveryQuote | null> {
    if (type !== OrderType.DELIVERY) {
      return null;
    }

    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, deletedAt: null },
      select: {
        latitude: true,
        longitude: true,
        settings: { select: { ...deliveryRuleColumns, acceptsDelivery: true } },
      },
    });

    if (branch?.settings && !branch.settings.acceptsDelivery) {
      throw new BadRequestException('This branch does not offer delivery.');
    }

    const rules = toRules(branch?.settings);

    const distanceKm = deliveryDistanceKm(
      branch?.latitude && branch.longitude
        ? { latitude: branch.latitude.toNumber(), longitude: branch.longitude.toNumber() }
        : null,
      destination,
      rules.roadFactor,
    );

    return priceDelivery(rules, distanceKm, itemSubtotalMinor);
  }

  /**
   * Refuses a delivery the branch's rules do not allow.
   *
   * Separate from {@link quoteDelivery} on purpose: a quote that threw would
   * leave the customer's basket screen with an error and no totals, which is
   * exactly when they most need to see how far off the minimum they are.
   * Placement is where it has to be a refusal.
   */
  assertDeliverable(quote: DeliveryQuote | null): void {
    const blocker = quote?.blockers[0];

    if (!blocker) {
      return;
    }

    if (blocker.code === 'BELOW_MINIMUM') {
      throw new BadRequestException(
        `Delivery orders start at ${formatSar(blocker.minOrderMinor)} SAR. ` +
          `Add ${formatSar(blocker.shortfallMinor)} SAR more to continue.`,
      );
    }

    throw new BadRequestException(
      `This address is ${blocker.distanceKm} km away and this branch delivers ` +
        `up to ${blocker.maxRadiusKm} km.`,
    );
  }
}

/** Halalas to riyals, for a customer-facing message. Display only. */
function formatSar(minor: number): string {
  return (minor / 100).toFixed(2).replace(/\.00$/, '');
}

/**
 * The open/closed fields a customer-facing branch row carries.
 *
 * `opensAt` is here because "closed" and "closed, opens at 17:00" are different
 * things to someone deciding whether to wait; `closedNote` because "closed for
 * Eid" answers the next question and a bare "closed" invites a phone call to a
 * branch with nobody in it.
 */
function openStateFields(state: BranchOpenState | undefined) {
  if (!state) {
    // No state resolved for this branch — treat it as unrestricted, the same
    // direction every other unknown here falls. Refusing a customer over our
    // own missing data is the more expensive error.
    return { isOpenNow: true, opensAt: null, closesAt: null, closedNote: null };
  }
  return {
    isOpenNow: acceptsOrdersNow(state),
    opensAt: formatMinute(state.opensAtMinute),
    closesAt: formatMinute(state.closesAtMinute),
    closedNote: state.note,
  };
}
