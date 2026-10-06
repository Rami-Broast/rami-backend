import { ChargeAppliesTo, ChargeType, OrderType, PaymentMethod } from '@prisma/client';

import { Minor } from '../common/money';
import { ResolvedCharge } from '../vat/pricing.types';

export interface ChargeRecord {
  id: string;
  name: string;
  nameAr: string | null;
  type: ChargeType;
  appliesTo: ChargeAppliesTo;
  amountMinor: number | null;
  percentBps: number | null;
  taxable: boolean;
  taxClass: string;
  branchIds: string[] | null;
  conditions: ChargeConditions | null;
  priority: number;
  startsAt: Date | null;
  endsAt: Date | null;
  isActive: boolean;
}

export interface ChargeConditions {
  orderTypes?: string[];
  minSubtotalMinor?: number;
  maxSubtotalMinor?: number;
  paymentMethods?: string[];
}

export interface ChargeContext {
  branchId: string;
  subtotalMinor: Minor;
  deliveryFeeMinor: Minor;
  itemCount: number;
  orderType: OrderType;
  paymentMethod?: PaymentMethod;
  at: Date;
}

export function evaluateCharges(
  charges: readonly ChargeRecord[],
  ctx: ChargeContext,
): ResolvedCharge[] {
  return charges
    .filter((c) => isApplicable(c, ctx))
    .sort((a, b) => a.priority - b.priority)
    .map((c) => resolveCharge(c, ctx));
}

function isApplicable(charge: ChargeRecord, ctx: ChargeContext): boolean {
  if (!charge.isActive) return false;

  if (charge.startsAt && ctx.at < charge.startsAt) return false;
  if (charge.endsAt && ctx.at >= charge.endsAt) return false;

  if (charge.branchIds && charge.branchIds.length > 0) {
    if (!charge.branchIds.includes(ctx.branchId)) return false;
  }

  if (charge.conditions) {
    const cond = charge.conditions;

    if (cond.orderTypes && cond.orderTypes.length > 0) {
      if (!cond.orderTypes.includes(ctx.orderType)) return false;
    }

    if (cond.minSubtotalMinor != null && ctx.subtotalMinor < cond.minSubtotalMinor) return false;
    if (cond.maxSubtotalMinor != null && ctx.subtotalMinor > cond.maxSubtotalMinor) return false;

    if (cond.paymentMethods && cond.paymentMethods.length > 0 && ctx.paymentMethod) {
      if (!cond.paymentMethods.includes(ctx.paymentMethod)) return false;
    }
  }

  return true;
}

function resolveCharge(charge: ChargeRecord, ctx: ChargeContext): ResolvedCharge {
  const base =
    charge.appliesTo === ChargeAppliesTo.DELIVERY ? ctx.deliveryFeeMinor : ctx.subtotalMinor;

  let amountMinor: Minor;
  switch (charge.type) {
    case ChargeType.FIXED:
      amountMinor = charge.amountMinor ?? 0;
      break;
    case ChargeType.PERCENTAGE:
      amountMinor = Math.round((base * (charge.percentBps ?? 0)) / 10_000);
      break;
    case ChargeType.PER_ITEM:
      amountMinor = (charge.amountMinor ?? 0) * ctx.itemCount;
      break;
  }

  return {
    chargeId: charge.id,
    name: charge.name,
    nameAr: charge.nameAr ?? undefined,
    amountMinor,
    taxable: charge.taxable,
    taxClass: charge.taxClass as ResolvedCharge['taxClass'],
  };
}
