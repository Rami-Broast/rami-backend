import { Prisma } from '@prisma/client';

/**
 * Turning a stored coordinate into one a client can use.
 *
 * `Driver.currentLatitude/Longitude` and `Delivery.distanceKm` are
 * `Decimal` columns, and **`Prisma.Decimal` serialises to a JSON string**, not
 * a number — `JSON.stringify(new Decimal('24.72'))` is `"24.72"`. Every view
 * that selected those columns raw therefore shipped `"24.72"` to the apps,
 * where the type said `number`. That is invisible to TypeScript on both sides
 * (the backend's type is `Decimal`, the client's is `number`, and nothing
 * compares the two) and it broke two screens at once:
 *
 *  - the **customer's tracking map**, which called `.toFixed()` on the value
 *    and threw inside render, so a customer chasing their food met the error
 *    boundary the moment a driver had a position;
 *  - the **owner's live fleet map**, where a string coordinate is not a
 *    `LatLng` — the pin never landed and the map sat on its hard-coded
 *    fallback centre, which is what "the map opens somewhere random" was.
 *
 * The money columns do not have this problem because they are integer minor
 * units; the `BigInt` settlement aggregates have their own serialiser for the
 * same class of reason (`SettlementsService.serialize`). This is that rule
 * applied to coordinates: **a Decimal crossing the API is converted
 * deliberately, at the boundary, or it crosses as a string.**
 */
export function toCoordinate(value: Prisma.Decimal | number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const asNumber = typeof value === 'number' ? value : value.toNumber();
  // A stored NaN cannot happen through Prisma, but a `null`-shaped Decimal from
  // a raw query could — and `NaN` in JSON is `null` anyway, so say so here
  // rather than emitting something no client can read.
  return Number.isFinite(asNumber) ? asNumber : null;
}
