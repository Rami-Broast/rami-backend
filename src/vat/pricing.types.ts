import { Prisma, TaxClass } from '@prisma/client';

import { Minor } from '../common/money';

/**
 * Inputs and outputs of the pricing engine.
 *
 * The engine takes *resolved* catalog data — prices already looked up from the
 * database, with branch overrides applied — rather than raw client input. A
 * client never supplies a price, so a tampered request cannot change what is
 * charged.
 */

/** One line as requested by a client: what to buy, not what it costs. */
export interface RequestedItem {
  productId: string;
  productVariantId?: string;
  quantity: number;
  addonIds?: readonly string[];
  notes?: string;
}

/** A modifier resolved against the catalog. */
export interface ResolvedAddon {
  addonId: string;
  modifierGroupName: string;
  addonName: string;
  unitPriceMinor: Minor;
  taxClass: TaxClass;
  quantity: number;
}

/** A line resolved against the catalog — prices are server-side facts. */
export interface ResolvedLine {
  productId: string;
  productVariantId?: string;
  productName: string;
  variantName?: string;
  /** Unit price for the product/variant, before add-ons. */
  unitPriceMinor: Minor;
  quantity: number;
  taxClass: TaxClass;
  addons: readonly ResolvedAddon[];
  notes?: string;
}

/**
 * A discount already decided elsewhere.
 *
 * Coupon eligibility is Phase 17. The engine applies a discount it is given; it
 * never decides whether one is allowed. That split keeps a coupon rule change
 * from being able to alter tax arithmetic.
 */
export interface ResolvedDiscount {
  /** Source, e.g. a coupon code, recorded on the breakdown for audit. */
  source: string;
  /** Amount off, in minor units, before VAT considerations. */
  amountMinor: Minor;
  /** True when the discount targets the delivery fee rather than the items. */
  appliesToDeliveryFee?: boolean;
}

export interface PricingRequest {
  currency: 'SAR';
  lines: readonly ResolvedLine[];
  /** Zero for pickup. */
  deliveryFeeMinor: Minor;
  discounts?: readonly ResolvedDiscount[];
  /** Custom charges already evaluated and resolved. */
  charges?: readonly ResolvedCharge[];
}

/** Per-line result. Carries everything an invoice line needs. */
export interface PricedLine {
  productId: string;
  productVariantId?: string;
  productName: string;
  variantName?: string;
  taxClass: TaxClass;
  quantity: number;
  notes?: string;

  /** Unit price as charged, add-ons excluded. */
  unitPriceMinor: Minor;
  /** Gross for the line before any discount: (unit + add-ons) x quantity. */
  lineSubtotalMinor: Minor;
  /** This line's share of the order discount. */
  lineDiscountMinor: Minor;
  /** Net of VAT, after discount. */
  lineTaxableBaseMinor: Minor;
  lineVatMinor: Minor;
  /** What this line contributes to the total: taxable base + VAT. */
  lineTotalMinor: Minor;
  vatRate: Prisma.Decimal;

  addons: readonly PricedAddon[];
}

export interface PricedAddon {
  addonId: string;
  modifierGroupName: string;
  addonName: string;
  unitPriceMinor: Minor;
  quantity: number;
  lineTotalMinor: Minor;
}

/** A resolved custom charge ready for the pricing engine. */
export interface ResolvedCharge {
  chargeId: string;
  name: string;
  nameAr?: string;
  amountMinor: Minor;
  taxable: boolean;
  taxClass: TaxClass;
}

/** A taxable or non-taxable charge that is not an item, e.g. delivery. */
export interface PricedFee {
  kind: 'DELIVERY' | 'CHARGE';
  chargeId?: string;
  label: string;
  labelAr?: string;
  grossMinor: Minor;
  discountMinor: Minor;
  taxableBaseMinor: Minor;
  vatMinor: Minor;
  totalMinor: Minor;
  taxable: boolean;
}

/**
 * The complete, authoritative price for a cart.
 *
 * Snapshotted onto the order verbatim. Two invariants hold and are tested:
 *
 *   taxableBase + vat === total
 *   sum(line totals) + sum(fee totals) === total
 *
 * They matter because invoices are built from the lines while payment is taken
 * on the total; if those two disagree by even one halala, the invoice does not
 * reconcile against the payment.
 */
export interface PriceQuote {
  currency: 'SAR';
  vatRate: Prisma.Decimal;
  pricesIncludeVat: boolean;

  lines: readonly PricedLine[];
  fees: readonly PricedFee[];

  /** Gross item total before discount. */
  subtotalMinor: Minor;
  discountMinor: Minor;
  deliveryFeeMinor: Minor;
  chargesMinor: Minor;
  taxableBaseMinor: Minor;
  vatMinor: Minor;
  totalMinor: Minor;

  /** Applied discounts, retained for audit and dispute resolution. */
  appliedDiscounts: readonly ResolvedDiscount[];
  /**
   * The two halves of `discountMinor`, **after** the engine's clamp.
   *
   * A caller recording what each discount actually gave has to know how much
   * survived the clamp in each bucket: two discounts asking for more than the
   * basket is worth are both cut down, and recording what they *asked* for
   * would put a giveaway on the books that never happened.
   */
  itemDiscountMinor: Minor;
  deliveryDiscountMinor: Minor;
}
