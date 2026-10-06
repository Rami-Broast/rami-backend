import {
  applyDeliveryUplift,
  DeliveryPricingRules,
  deliveryDistanceKm,
  haversineKm,
  priceDelivery,
  upliftPercentFor,
} from '../../src/delivery-pricing/delivery-pricing';

/**
 * The owner's confirmed numbers (2026-09-04), in halalas:
 * minimum 40 SAR, base fee 5 SAR covering 5 km, 3 SAR per further km.
 *
 * These tests are written in riyals in their names on purpose. When the owner
 * says "7 km should cost 11 riyals", this file is where that sentence is
 * checked — not a screenshot of a checkout page.
 */
const OWNER_DEFAULTS: DeliveryPricingRules = {
  baseFeeMinor: 500,
  baseFeeCoversKm: 5,
  perKmFeeMinor: 300,
  maxRadiusKm: 20,
  roadFactor: 1.3,
  minOrderMinor: 4000,
};

const ABOVE_MINIMUM = 6000;

describe('priceDelivery — the fee', () => {
  it('charges the base fee alone inside the covered distance', () => {
    const quote = priceDelivery(OWNER_DEFAULTS, 4.2, ABOVE_MINIMUM);

    expect(quote.chargeableKm).toBe(0);
    expect(quote.distanceFeeMinor).toBe(0);
    expect(quote.deliveryFeeMinor).toBe(500);
  });

  it('charges the base fee alone exactly at the covered distance', () => {
    // 5.00 km on a 5 km base is still 5 SAR. The boundary belongs to the
    // customer, not to us.
    expect(priceDelivery(OWNER_DEFAULTS, 5, ABOVE_MINIMUM).deliveryFeeMinor).toBe(500);
  });

  it('charges 11 SAR at 7 km — 5 base plus two further km', () => {
    const quote = priceDelivery(OWNER_DEFAULTS, 7, ABOVE_MINIMUM);

    expect(quote.chargeableKm).toBe(2);
    expect(quote.distanceFeeMinor).toBe(600);
    expect(quote.deliveryFeeMinor).toBe(1100);
  });

  it('charges a started kilometre in full', () => {
    // 5.1 km is one chargeable km, not a tenth of one. A fee of 5.30 is a
    // fee nobody can reproduce in their head.
    const quote = priceDelivery(OWNER_DEFAULTS, 5.1, ABOVE_MINIMUM);

    expect(quote.chargeableKm).toBe(1);
    expect(quote.deliveryFeeMinor).toBe(800);
  });

  it('treats a negative distance as zero rather than paying the customer', () => {
    expect(priceDelivery(OWNER_DEFAULTS, -3, ABOVE_MINIMUM).deliveryFeeMinor).toBe(500);
  });

  it('follows the owner when the owner changes the numbers', () => {
    const changed: DeliveryPricingRules = {
      ...OWNER_DEFAULTS,
      baseFeeMinor: 1000,
      baseFeeCoversKm: 2,
      perKmFeeMinor: 150,
    };

    // 6 km: 10 SAR base + 4 further km at 1.50 = 16 SAR.
    expect(priceDelivery(changed, 6, ABOVE_MINIMUM).deliveryFeeMinor).toBe(1600);
  });
});

describe('priceDelivery — an unmeasurable distance', () => {
  it('charges the base fee and does not refuse the order', () => {
    const quote = priceDelivery(OWNER_DEFAULTS, null, ABOVE_MINIMUM);

    expect(quote.distanceKm).toBeNull();
    expect(quote.deliveryFeeMinor).toBe(500);
    expect(quote.blockers).toEqual([]);
  });

  it('cannot be out of range, because there is no range to be out of', () => {
    // Deliberate: refusing delivery because our own geocoding failed turns a
    // paying customer away over missing data of ours.
    expect(priceDelivery(OWNER_DEFAULTS, null, ABOVE_MINIMUM).blockers).toEqual([]);
  });
});

describe('priceDelivery — the blockers', () => {
  it('refuses beyond the radius', () => {
    const quote = priceDelivery(OWNER_DEFAULTS, 24, ABOVE_MINIMUM);

    expect(quote.blockers).toEqual([{ code: 'OUT_OF_RANGE', distanceKm: 24, maxRadiusKm: 20 }]);
  });

  it('allows delivery exactly at the radius', () => {
    expect(priceDelivery(OWNER_DEFAULTS, 20, ABOVE_MINIMUM).blockers).toEqual([]);
  });

  it('never refuses on distance when the owner set no limit', () => {
    const unlimited = { ...OWNER_DEFAULTS, maxRadiusKm: null };

    expect(priceDelivery(unlimited, 300, ABOVE_MINIMUM).blockers).toEqual([]);
  });

  it('reports the shortfall to the minimum, so the app can say how much more', () => {
    const quote = priceDelivery(OWNER_DEFAULTS, 3, 3250);

    expect(quote.shortfallMinor).toBe(750);
    expect(quote.blockers).toEqual([
      { code: 'BELOW_MINIMUM', shortfallMinor: 750, minOrderMinor: 4000 },
    ]);
  });

  it('meets the minimum exactly at 40 SAR', () => {
    const quote = priceDelivery(OWNER_DEFAULTS, 3, 4000);

    expect(quote.shortfallMinor).toBe(0);
    expect(quote.blockers).toEqual([]);
  });

  it('measures the minimum on items only — distance cannot help reach it', () => {
    // 38 SAR of food, 11 SAR of delivery. 49 SAR total, still short.
    const quote = priceDelivery(OWNER_DEFAULTS, 7, 3800);

    expect(quote.deliveryFeeMinor).toBe(1100);
    expect(quote.shortfallMinor).toBe(200);
  });

  it('reports both blockers at once rather than one at a time', () => {
    const quote = priceDelivery(OWNER_DEFAULTS, 30, 1000);

    expect(quote.blockers.map((b) => b.code).sort()).toEqual(['BELOW_MINIMUM', 'OUT_OF_RANGE']);
  });
});

describe('distance', () => {
  it('measures a known distance to within a percent', () => {
    // Riyadh (Kingdom Centre) to Diriyah, ~19 km great-circle.
    const km = haversineKm(
      { latitude: 24.7118, longitude: 46.6745 },
      { latitude: 24.7371, longitude: 46.5757 },
    );

    expect(km).toBeGreaterThan(9.5);
    expect(km).toBeLessThan(10.5);
  });

  it('is zero between a point and itself', () => {
    const p = { latitude: 24.7118, longitude: 46.6745 };

    expect(haversineKm(p, p)).toBeCloseTo(0, 6);
  });

  it('inflates the straight line by the road factor', () => {
    const branch = { latitude: 24.7118, longitude: 46.6745 };
    const drop = { latitude: 24.7371, longitude: 46.5757 };

    const straight = haversineKm(branch, drop);
    const road = deliveryDistanceKm(branch, drop, 1.3);

    expect(road).not.toBeNull();
    expect(road as number).toBeCloseTo(Math.round(straight * 1.3 * 100) / 100, 1);
  });

  it('is unknown when the branch has no coordinates', () => {
    expect(deliveryDistanceKm(null, { latitude: 24.7, longitude: 46.6 }, 1.3)).toBeNull();
    expect(deliveryDistanceKm({}, { latitude: 24.7, longitude: 46.6 }, 1.3)).toBeNull();
  });

  it('is unknown when the drop-off has no coordinates', () => {
    expect(deliveryDistanceKm({ latitude: 24.7, longitude: 46.6 }, undefined, 1.3)).toBeNull();
  });

  it('rejects coordinates that are not coordinates', () => {
    const branch = { latitude: 24.7, longitude: 46.6 };

    expect(deliveryDistanceKm(branch, { latitude: 91, longitude: 46.6 }, 1.3)).toBeNull();
    expect(deliveryDistanceKm(branch, { latitude: 24.7, longitude: 181 }, 1.3)).toBeNull();
    expect(deliveryDistanceKm(branch, { latitude: NaN, longitude: 46.6 }, 1.3)).toBeNull();
  });
});

describe('the delivery price uplift', () => {
  it('leaves a price alone at zero percent', () => {
    expect(applyDeliveryUplift(3250, 0)).toBe(3250);
  });

  it('raises a 32.50 dish to 35.10 at 8 percent', () => {
    expect(applyDeliveryUplift(3250, 8)).toBe(3510);
  });

  it('rounds to the halala rather than carrying a fraction into the order', () => {
    // 1299 * 1.07 = 1389.93
    expect(applyDeliveryUplift(1299, 7)).toBe(1390);
  });

  it('never turns a free item into a paid one', () => {
    expect(applyDeliveryUplift(0, 25)).toBe(0);
  });

  it('ignores a nonsensical percentage rather than producing a nonsensical price', () => {
    expect(applyDeliveryUplift(3250, -10)).toBe(3250);
    expect(applyDeliveryUplift(3250, NaN)).toBe(3250);
  });
});

describe('which uplift applies to a product', () => {
  it('uses the branch default when the product has no override', () => {
    expect(upliftPercentFor(null, 8)).toBe(8);
    expect(upliftPercentFor(undefined, 8)).toBe(8);
  });

  it('uses the product override when it has one', () => {
    expect(upliftPercentFor(15, 8)).toBe(15);
  });

  it('respects an override of zero — "never uplift this item" is a real choice', () => {
    // The bug this guards: `override || branchDefault` would silently apply 8%.
    expect(upliftPercentFor(0, 8)).toBe(0);
  });
});
