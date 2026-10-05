import { isProductAvailable } from '../../src/menu/product-availability';

/**
 * The sell / don't-sell rule.
 *
 * Both bugs this covers were live in production and neither was visible to a
 * test: every product created in the admin panel was sold out at every branch,
 * and "sold out until 6pm" never came back on its own.
 */
describe('isProductAvailable', () => {
  const now = Date.UTC(2026, 8, 4, 12, 0, 0);
  const future = new Date(now + 60 * 60 * 1000);
  const past = new Date(now - 60 * 60 * 1000);

  it('treats a missing row as available', () => {
    // The regression that mattered most: a row is only written by the seed or
    // by a branch toggling something off, so a newly created product has none
    // anywhere. Requiring one made every new dish unorderable at every branch.
    expect(isProductAvailable(undefined, now)).toBe(true);
  });

  it('respects an explicit indefinite stop', () => {
    expect(isProductAvailable({ isAvailable: false, unavailableUntil: null }, now)).toBe(false);
  });

  it('is available when a row says so', () => {
    expect(isProductAvailable({ isAvailable: true, unavailableUntil: null }, now)).toBe(true);
  });

  it('is sold out while the until-window is still open', () => {
    expect(isProductAvailable({ isAvailable: false, unavailableUntil: future }, now)).toBe(false);
  });

  it('restores itself once the until-window has passed', () => {
    // This is what "sold out until 6pm" has to mean. Previously the check
    // required `isAvailable` to be true as well — and turning an item off
    // stores it as false — so the timestamp could never bring anything back
    // and someone had to remember to re-enable it by hand.
    expect(isProductAvailable({ isAvailable: false, unavailableUntil: past }, now)).toBe(true);
  });

  it('lets the window govern even when the flag disagrees', () => {
    // A window that is still open wins over a stale `isAvailable: true`, so the
    // two fields can never combine into "on and off at the same time".
    expect(isProductAvailable({ isAvailable: true, unavailableUntil: future }, now)).toBe(false);
  });

  it('is exactly available at the boundary instant', () => {
    expect(isProductAvailable({ isAvailable: false, unavailableUntil: new Date(now) }, now)).toBe(
      true,
    );
  });
});
