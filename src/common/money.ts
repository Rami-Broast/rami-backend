/**
 * Exact money arithmetic in integer minor units (halalas for SAR).
 *
 * Every function here takes and returns integers. Nothing in this file — or in
 * anything that calls it — may represent money as a floating point number:
 * 0.1 + 0.2 is not 0.3 in binary floating point, and a tax audit will find the
 * accumulated difference.
 *
 * Rates are the one exception. A VAT rate is a ratio, not an amount, so it is
 * carried as a `Decimal` and only ever multiplied *into* an integer amount,
 * with the result rounded back to an integer immediately.
 */

import { Prisma } from '@prisma/client';

export type Minor = number;

/** Guards against a non-integer amount reaching money arithmetic. */
export function assertMinor(amount: number, label = 'amount'): void {
  if (!Number.isInteger(amount)) {
    throw new Error(`${label} must be an integer in minor units, received ${amount}`);
  }

  if (!Number.isSafeInteger(amount)) {
    throw new Error(`${label} exceeds the safe integer range`);
  }
}

/**
 * Rounds to the nearest integer, with exact halves going away from zero.
 *
 * `Math.round` breaks ties towards positive infinity, so it rounds -0.5 to 0
 * but 0.5 to 1 — asymmetric, which shows up as a one-halala discrepancy
 * between a refund and the charge it reverses. Half-away-from-zero keeps a
 * credit note the exact mirror of its invoice.
 */
export function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * Multiplies an integer amount by a decimal rate, returning integer minor units.
 *
 * The multiplication is done in `Decimal` rather than in JavaScript numbers, so
 * a rate like 0.15 does not introduce binary representation error before the
 * rounding step.
 */
export function applyRate(amountMinor: Minor, rate: Prisma.Decimal): Minor {
  assertMinor(amountMinor, 'amountMinor');

  const product = new Prisma.Decimal(amountMinor).mul(rate);

  return roundHalfAwayFromZero(product.toNumber());
}

/**
 * Extracts the tax component from a VAT-inclusive amount.
 *
 * For a gross of G at rate r: net = G / (1 + r), tax = G − net.
 *
 * The tax is derived by subtraction rather than computed independently, which
 * guarantees `net + tax === gross` exactly. Computing both and rounding each
 * separately can produce a pair that does not add up to what the customer pays.
 */
export function splitVatInclusive(
  grossMinor: Minor,
  rate: Prisma.Decimal,
): { netMinor: Minor; vatMinor: Minor } {
  assertMinor(grossMinor, 'grossMinor');

  const divisor = new Prisma.Decimal(1).plus(rate);
  const net = roundHalfAwayFromZero(new Prisma.Decimal(grossMinor).div(divisor).toNumber());

  return { netMinor: net, vatMinor: grossMinor - net };
}

/**
 * Adds VAT to a VAT-exclusive amount.
 */
export function addVatExclusive(
  netMinor: Minor,
  rate: Prisma.Decimal,
): { grossMinor: Minor; vatMinor: Minor } {
  assertMinor(netMinor, 'netMinor');

  const vat = applyRate(netMinor, rate);

  return { grossMinor: netMinor + vat, vatMinor: vat };
}

/**
 * Splits `totalMinor` across `weights` so that the parts sum to exactly
 * `totalMinor`.
 *
 * Uses the largest-remainder method: floor every share, then hand the leftover
 * units one at a time to the entries with the largest discarded fractions.
 *
 * This matters because a discount distributed across order lines has to add up.
 * Rounding each share independently loses or invents halalas, and the resulting
 * invoice would not reconcile against the payment — the kind of one-halala
 * discrepancy that is invisible in testing and unresolvable in an audit.
 *
 * A zero total, or weights that are all zero, allocates nothing.
 */
export function allocateProportionally(totalMinor: Minor, weights: readonly number[]): Minor[] {
  assertMinor(totalMinor, 'totalMinor');

  if (weights.length === 0) {
    return [];
  }

  if (weights.some((weight) => weight < 0)) {
    throw new Error('allocation weights must not be negative');
  }

  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);

  if (weightTotal === 0 || totalMinor === 0) {
    return weights.map(() => 0);
  }

  const exact = weights.map((weight) => (totalMinor * weight) / weightTotal);
  const floored = exact.map((value) => Math.floor(value));
  let remainder = totalMinor - floored.reduce((sum, value) => sum + value, 0);

  // Distribute the leftover units to the largest fractional parts first, so the
  // allocation is deterministic and as close to proportional as integers allow.
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  const result = [...floored];
  let cursor = 0;

  while (remainder > 0 && order.length > 0) {
    result[order[cursor % order.length].index] += 1;
    remainder -= 1;
    cursor += 1;
  }

  return result;
}

/** Sums integer minor amounts, rejecting any non-integer input. */
export function sumMinor(amounts: readonly Minor[]): Minor {
  for (const amount of amounts) {
    assertMinor(amount);
  }

  return amounts.reduce((sum, amount) => sum + amount, 0);
}

/**
 * Formats minor units for display and logs, e.g. 3250 -> "32.50".
 *
 * Presentation only. Never parse this back into an amount — the integer is the
 * value, and a formatted string is a lossy view of it.
 */
export function formatMinor(amountMinor: Minor, fractionDigits = 2): string {
  assertMinor(amountMinor, 'amountMinor');

  const divisor = 10 ** fractionDigits;
  const sign = amountMinor < 0 ? '-' : '';
  const absolute = Math.abs(amountMinor);
  const whole = Math.floor(absolute / divisor);
  const fraction = String(absolute % divisor).padStart(fractionDigits, '0');

  return `${sign}${whole}.${fraction}`;
}
