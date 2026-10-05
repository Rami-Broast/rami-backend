/**
 * Whether a product may be sold at a branch right now.
 *
 * Pure, and shared by the branch menu and by cart resolution, because those two
 * disagreeing is how a customer builds a basket that fails at checkout.
 */
export interface AvailabilityRow {
  isAvailable: boolean;
  unavailableUntil: Date | null;
}

/**
 * **A missing row means available.**
 *
 * It used to mean sold out, which made every product created in the admin panel
 * unavailable at every branch the moment it was created — a row is only written
 * by the seed or by a branch explicitly toggling something off, so a new product
 * had no row anywhere and could never be ordered. The owner adds a dish
 * expecting to sell it; absence of an opinion is not an opinion.
 *
 * The inverse risk is real but smaller and self-correcting: a new product goes
 * on sale at every branch at once, and any branch that cannot make it turns it
 * off in one tap. That beats a menu where nothing is orderable until someone
 * has toggled every item at every branch.
 *
 * **`unavailableUntil` governs while it is set.** "Sold out until 6pm" has to
 * come back at 6pm without anyone remembering — which it previously did not:
 * turning an item off stored `isAvailable: false` alongside the timestamp, and
 * the check required `isAvailable` to be true, so the window could never
 * restore it. The timestamp was dead weight. Now the window is the deciding
 * fact whenever it is present, and `isAvailable` governs only an indefinite
 * stop with no end time.
 */
export function isProductAvailable(row: AvailabilityRow | undefined, now: number): boolean {
  if (row === undefined) {
    return true;
  }

  if (row.unavailableUntil !== null) {
    return row.unavailableUntil.getTime() <= now;
  }

  return row.isAvailable;
}
