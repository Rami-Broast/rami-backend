import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { BannersService } from '../banners/banners.service';
import { CouponsService } from '../coupons/coupons.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { HomepageService } from '../homepage/homepage.service';
import { PrismaService } from '../prisma/prisma.service';
import { PromotionsService } from '../promotions/promotions.service';

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
  settings: {
    select: {
      acceptsDelivery: true,
      acceptsPickup: true,
      isAcceptingOrders: true,
      acceptsCashOnDelivery: true,
      deliveryRadiusKm: true,
      deliveryFeeMinor: true,
      minOrderMinor: true,
      prepTimeMinutes: true,
      openingHours: true,
      timezone: true,
    },
  },
  openingHours: {
    select: {
      dayOfWeek: true,
      openMinute: true,
      closeMinute: true,
      isClosed: true,
    },
    orderBy: [{ dayOfWeek: 'asc' as const }, { openMinute: 'asc' as const }],
  },
} satisfies Prisma.BranchSelect;

@Injectable()
export class CustomerConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly featureFlags: FeatureFlagsService,
    private readonly banners: BannersService,
    private readonly homepage: HomepageService,
    private readonly promotions: PromotionsService,
    private readonly coupons: CouponsService,
  ) {}

  async getConfig() {
    const [branches, features, version, banners, homepageSections, promotions, offers] =
      await Promise.all([
        this.prisma.branch.findMany({
          where: { isActive: true, deletedAt: null },
          select: branchSelect,
          orderBy: { name: 'asc' },
        }),
        this.featureFlags.getEnabledMap(),
        this.featureFlags.getConfigVersion(),
        this.banners.listActive(),
        this.homepage.listEnabled(),
        this.promotions.listActive(),
        // Offers are the owner's published coupons — the card the customer taps
        // carries the very code the checkout will accept, so there is no second
        // discount path to keep in step with the pricing engine.
        this.coupons.listPublic(),
      ]);

    return {
      version,
      features,
      offers,
      banners: banners.map((b) => ({
        id: b.id,
        imageUrl: b.imageUrl,
        imageUrlAr: b.imageUrlAr ?? undefined,
        title: b.title,
        titleAr: b.titleAr ?? undefined,
        description: b.description ?? undefined,
        descriptionAr: b.descriptionAr ?? undefined,
        buttonText: b.buttonText ?? undefined,
        buttonTextAr: b.buttonTextAr ?? undefined,
        action: b.action,
        targetId: b.targetId ?? undefined,
        targetUrl: b.targetUrl ?? undefined,
        branchIds: b.branchIds,
        priority: b.priority,
      })),
      // Automatic discounts. Unlike `offers`, these carry no code and nothing
      // to tap — a qualifying cart gets one at checkout. `branchIds` is
      // included (empty meaning every branch, as elsewhere) because this
      // endpoint is branch-agnostic: without it the app would advertise a
      // promotion that only another branch runs, which is the same "shown a
      // deal they could not have" failure the offers list is filtered against.
      promotions: promotions.map((p) => ({
        id: p.id,
        name: p.name,
        branchIds: p.branchIds,
        nameAr: p.nameAr ?? undefined,
        description: p.description ?? undefined,
        descriptionAr: p.descriptionAr ?? undefined,
        imageUrl: p.imageUrl ?? undefined,
        discountType: p.discountType,
        discountValue: Number(p.discountValue),
        maxDiscountMinor: p.maxDiscountMinor ?? undefined,
        startsAt: p.startsAt.toISOString(),
        endsAt: p.endsAt.toISOString(),
        priority: p.priority,
        products: p.items
          .filter((i) => i.product.isActive)
          .map((i) => ({
            id: i.product.id,
            name: i.product.name,
            nameAr: i.product.nameAr ?? undefined,
            imageUrl: i.product.imageUrl ?? undefined,
            basePriceMinor: i.product.basePriceMinor,
          })),
      })),
      homepageSections: homepageSections.map((s) => ({
        id: s.id,
        kind: s.kind,
        title: s.title ?? undefined,
        titleAr: s.titleAr ?? undefined,
        position: s.position,
        config: s.config ?? undefined,
      })),
      branches: branches.map((b) => ({
        id: b.id,
        code: b.code,
        name: b.name,
        nameAr: b.nameAr,
        phone: b.phone,
        address: b.addressLine,
        district: b.district,
        city: b.city,
        latitude: b.latitude ? Number(b.latitude) : null,
        longitude: b.longitude ? Number(b.longitude) : null,
        openingHours: b.openingHours,
        settings: b.settings
          ? {
              acceptsDelivery: b.settings.acceptsDelivery,
              acceptsPickup: b.settings.acceptsPickup,
              isAcceptingOrders: b.settings.isAcceptingOrders,
              acceptsCashOnDelivery: b.settings.acceptsCashOnDelivery,
              // Null is a real value here — "no limit" — and `Number(null)` is
              // 0, which reads as a branch that delivers nowhere.
              deliveryRadiusKm:
                b.settings.deliveryRadiusKm === null ? null : Number(b.settings.deliveryRadiusKm),
              deliveryFeeMinor: b.settings.deliveryFeeMinor,
              minOrderMinor: b.settings.minOrderMinor,
              prepTimeMinutes: b.settings.prepTimeMinutes,
              openingHours: b.settings.openingHours,
              timezone: b.settings.timezone,
            }
          : null,
      })),
    };
  }
}
