import { Minor, roundHalfAwayFromZero } from '../common/money';

/**
 * Delivery pricing — the distance-based fee, the order minimum and the
 * delivery-only price uplift.
 *
 * Pure on purpose. Every number here is money, and money arithmetic that can
 * only be exercised through an HTTP request and a database is money arithmetic
 * nobody checks. The service layer reads the branch's rules and hands them in;
 * this file decides what the fee is, and is unit-tested against the owner's
 * stated numbers directly.
 *
 * The owner's confirmed defaults (2026-09-04): minimum order 40 SAR, base fee
 * 5 SAR covering the first 5 km, 3 SAR for each further km. Every one of those
 * is a column on `BranchSetting`, not a constant — they are business inputs and
 * the owner changes them per branch.
 */

/** Mean Earth radius in km. */
const EARTH_RADIUS_KM = 6371;

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

/**
 * A point that may not be one. Addresses and branches carry nullable
 * coordinates — an address saved without a map pin has none — so the callers
 * of this module hand over what they have and let `toPoint` decide.
 */
export type MaybeGeoPoint = {
  latitude?: number | null;
  longitude?: number | null;
};

export interface DeliveryPricingRules {
  /** Charged on every delivery, before any distance charge. */
  baseFeeMinor: Minor;
  /** Distance the base fee already covers. Beyond this, perKmFeeMinor applies. */
  baseFeeCoversKm: number;
  /** Charged per started kilometre beyond `baseFeeCoversKm`. */
  perKmFeeMinor: Minor;
  /** Refuse delivery beyond this distance. Null means no limit. */
  maxRadiusKm: number | null;
  /**
   * Straight-line distance is multiplied by this to approximate road distance.
   * Roads do not run in straight lines; 1.3 is the usual urban approximation.
   */
  roadFactor: number;
  /** Minimum item subtotal before a delivery order may be placed. */
  minOrderMinor: Minor;
}

export type DeliveryBlocker =
  | { code: 'OUT_OF_RANGE'; distanceKm: number; maxRadiusKm: number }
  | { code: 'BELOW_MINIMUM'; shortfallMinor: Minor; minOrderMinor: Minor };

export interface DeliveryQuote {
  /**
   * Road-adjusted distance in km, to two decimals. Null when we could not
   * measure it — see `distanceKnown` below for what that costs.
   */
  distanceKm: number | null;
  straightLineKm: number | null;
  baseFeeMinor: Minor;
  baseFeeCoversKm: number;
  /** Started kilometres beyond the covered distance, i.e. what is charged for. */
  chargeableKm: number;
  perKmFeeMinor: Minor;
  distanceFeeMinor: Minor;
  /** base + distance. This is the number that reaches the pricing engine. */
  deliveryFeeMinor: Minor;
  minOrderMinor: Minor;
  /** How much more the customer must add to reach the minimum. 0 when met. */
  shortfallMinor: Minor;
  maxRadiusKm: number | null;
  /** Empty means the order may be placed for delivery. */
  blockers: DeliveryBlocker[];
}

/** Great-circle distance between two points, in km. */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;

  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);

  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Rounds a distance to two decimals, so the same km never prices two ways. */
function roundKm(km: number): number {
  return roundHalfAwayFromZero(km * 100) / 100;
}

/**
 * Prices one delivery.
 *
 * `distanceKm` is the road-adjusted distance, or null when it could not be
 * measured — no coordinates on the branch, or a customer who typed an address
 * instead of dropping a pin. **An unmeasurable distance is charged the base fee
 * and is never refused.** Refusing to deliver because geocoding failed turns a
 * paying customer away over our own missing data; under-charging a few riyals
 * is the cheaper error. The quote records `distanceKm: null` so staff can see
 * which orders that happened on.
 *
 * Distance beyond the covered radius is charged per **started** kilometre:
 * 5.1 km on a 5 km base is one chargeable km, not 0.1. That is what "every
 * extra km is 3 SAR" means to the person saying it, and a fractional charge
 * would produce fees nobody can repeat by hand.
 */
export function priceDelivery(
  rules: DeliveryPricingRules,
  distanceKm: number | null,
  itemSubtotalMinor: Minor,
): DeliveryQuote {
  const blockers: DeliveryBlocker[] = [];

  const measured = distanceKm === null ? null : roundKm(Math.max(0, distanceKm));

  const chargeableKm =
    measured === null ? 0 : Math.max(0, Math.ceil(measured - rules.baseFeeCoversKm));

  const distanceFeeMinor = chargeableKm * rules.perKmFeeMinor;

  if (measured !== null && rules.maxRadiusKm !== null && measured > rules.maxRadiusKm) {
    blockers.push({ code: 'OUT_OF_RANGE', distanceKm: measured, maxRadiusKm: rules.maxRadiusKm });
  }

  // The minimum is measured on items alone. A customer must not be able to
  // reach it by living further away.
  const shortfallMinor = Math.max(0, rules.minOrderMinor - itemSubtotalMinor);

  if (shortfallMinor > 0) {
    blockers.push({ code: 'BELOW_MINIMUM', shortfallMinor, minOrderMinor: rules.minOrderMinor });
  }

  return {
    distanceKm: measured,
    straightLineKm: measured === null ? null : roundKm(measured / rules.roadFactor),
    baseFeeMinor: rules.baseFeeMinor,
    baseFeeCoversKm: rules.baseFeeCoversKm,
    chargeableKm,
    perKmFeeMinor: rules.perKmFeeMinor,
    distanceFeeMinor,
    deliveryFeeMinor: rules.baseFeeMinor + distanceFeeMinor,
    minOrderMinor: rules.minOrderMinor,
    shortfallMinor,
    maxRadiusKm: rules.maxRadiusKm,
    blockers,
  };
}

/** Road-adjusted distance between a branch and a drop-off, or null if either is unknown. */
export function deliveryDistanceKm(
  branch: MaybeGeoPoint | null | undefined,
  destination: MaybeGeoPoint | null | undefined,
  roadFactor: number,
): number | null {
  const from = toPoint(branch);
  const to = toPoint(destination);

  if (from === null || to === null) {
    return null;
  }

  return roundKm(haversineKm(from, to) * roadFactor);
}

function toPoint(value: MaybeGeoPoint | null | undefined): GeoPoint | null {
  if (!value) {
    return null;
  }

  const { latitude, longitude } = value;

  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return null;
  }

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return null;
  }

  return { latitude, longitude };
}

/**
 * Applies the delivery price uplift to one catalog price.
 *
 * The uplift is folded into the item price rather than added as a separate
 * line: the customer sees delivery prices on the menu once they choose
 * delivery, which is how every delivery app in the market behaves, and the
 * alternative reads as a second delivery fee on top of the first.
 *
 * Because it lands on `unitPriceMinor` **before** the pricing engine sees the
 * line, the uplift is inside the VAT-inclusive price and is snapshotted onto
 * the order line like any other price. The engine stays the single place a
 * payable amount is decided — this only changes what price goes into it.
 *
 * Rounds half away from zero to the halala, so an 8% uplift on 32.50 is one
 * price and not two.
 */
export function applyDeliveryUplift(unitPriceMinor: Minor, percent: number): Minor {
  if (!Number.isFinite(percent) || percent <= 0 || unitPriceMinor <= 0) {
    return unitPriceMinor;
  }

  return roundHalfAwayFromZero(unitPriceMinor * (1 + percent / 100));
}

/**
 * The uplift that applies to one product: its own override when it has one,
 * otherwise the branch default. A product override of 0 is a real choice
 * ("never uplift this item") and is respected — only null falls through.
 */
export function upliftPercentFor(
  productOverride: number | null | undefined,
  branchDefault: number,
): number {
  return productOverride ?? branchDefault;
}
