import { DeliveryQuote } from '../delivery-pricing/delivery-pricing';
import { Minor, sumMinor } from '../common/money';
import { PriceQuote } from './pricing.types';

/**
 * The itemised breakdown of one order's total.
 *
 * Built here, once, so that the customer's summary, the branch's order view and
 * the owner's order view show the *same* list. Three screens each assembling
 * their own rows from the same columns is three chances to leave one out, and
 * the one most often left out is the one the customer asks about.
 *
 * ## The trap this shape exists to close
 *
 * Prices are VAT-inclusive. The VAT row therefore does **not** add to the
 * total — it says how much of the total is tax. A list that simply sums its
 * rows would overstate every order by 15%. Every row carries `included`, and a
 * client renders an `included` row without adding it.
 */
export type BreakdownRowKind =
  'ITEMS' | 'DISCOUNT' | 'DELIVERY_BASE' | 'DELIVERY_DISTANCE' | 'CHARGE' | 'VAT' | 'TOTAL';

export interface BreakdownRow {
  kind: BreakdownRowKind;
  /** English label. Arabic is the client's to localise from `kind`. */
  label: string;
  /** Extra context — "2 km beyond 5 km", "15%". Null when the label says it all. */
  detail: string | null;
  amountMinor: Minor;
  /**
   * What this row would have cost without a discount, for a client to render
   * struck through beside the amount. Absent when nothing was discounted.
   *
   * A discount is shown this way rather than as its own negative row because
   * that is how a saving reads as a saving: "~~657~~ 328" is immediately a good
   * deal, while "Items 657 / Discount −329" is arithmetic the customer has to
   * do before they feel anything. The total saving is also stated once, plainly,
   * at the foot of the summary.
   */
  strikethroughMinor?: Minor;
  /**
   * True when this row is already inside the total and must not be added to
   * it: the VAT line on VAT-inclusive prices, and nothing else today.
   */
  included: boolean;
  /** True when the row reduces the total, so a client can render a minus sign. */
  negative: boolean;
}

/** Halalas to a plain riyal string, for a row's detail text. */
function sar(minor: Minor): string {
  return (minor / 100).toFixed(2);
}

export function buildOrderBreakdown(
  quote: PriceQuote,
  delivery: DeliveryQuote | null,
): BreakdownRow[] {
  // A discount can land on the items, on the delivery fee, or on both — the
  // engine allocates them separately — so each is struck through against its
  // own row rather than one lump being subtracted from the bill.
  const itemDiscountMinor = sumMinor(quote.lines.map((line) => line.lineDiscountMinor));
  const deliveryDiscountMinor = sumMinor(
    quote.fees.filter((fee) => fee.kind === 'DELIVERY').map((fee) => fee.discountMinor),
  );

  const itemsMinor = quote.subtotalMinor - itemDiscountMinor;

  const rows: BreakdownRow[] = [
    {
      kind: 'ITEMS',
      label: 'Item total',
      detail: null,
      amountMinor: itemsMinor,
      ...(itemDiscountMinor > 0 ? { strikethroughMinor: quote.subtotalMinor } : {}),
      included: false,
      negative: false,
    },
  ];

  // The delivery fee is split into the two things the customer was told about:
  // a flat fee, and distance. One "Delivery 11.00" row is the row people
  // dispute; "5.00 + 2 km × 3.00" is the row they accept.
  if (delivery !== null && delivery.deliveryFeeMinor > 0) {
    // A delivery discount is spent on the base fee first and then on the
    // distance fee, because the engine took it off the delivery leg as a whole.
    //
    // It used to come off the base fee only, and the leftover was simply
    // dropped: a free-delivery coupon on an order beyond the base-fee radius
    // discounted 14.00 in the total and 5.00 in the rows, so
    // `assertBreakdownAddsUp` threw and **the placement failed outright** — a
    // 500 on the Pay button, for the customer with the best coupon we issue.
    // The rows have to spend the whole discount because the total already has.
    const baseAfterDiscount = Math.max(0, delivery.baseFeeMinor - deliveryDiscountMinor);
    const discountLeftForDistance = Math.max(0, deliveryDiscountMinor - delivery.baseFeeMinor);
    const distanceAfterDiscount = Math.max(0, delivery.distanceFeeMinor - discountLeftForDistance);

    rows.push({
      kind: 'DELIVERY_BASE',
      label: 'Delivery fee',
      detail:
        delivery.distanceKm === null
          ? null
          : `${delivery.distanceKm} km · first ${delivery.baseFeeCoversKm} km included`,
      amountMinor: baseAfterDiscount,
      ...(deliveryDiscountMinor > 0 ? { strikethroughMinor: delivery.baseFeeMinor } : {}),
      included: false,
      negative: false,
    });

    if (delivery.distanceFeeMinor > 0) {
      rows.push({
        kind: 'DELIVERY_DISTANCE',
        label: 'Extra distance',
        detail:
          `${delivery.chargeableKm} km beyond ${delivery.baseFeeCoversKm} km ` +
          `× ${sar(delivery.perKmFeeMinor)}`,
        amountMinor: distanceAfterDiscount,
        ...(discountLeftForDistance > 0 ? { strikethroughMinor: delivery.distanceFeeMinor } : {}),
        included: false,
        negative: false,
      });
    }
  } else if (quote.deliveryFeeMinor > 0) {
    // A delivery fee with no delivery quote behind it: an older order, or a
    // path that priced the fee without distance. Show it rather than dropping
    // it — a total that does not add up is worse than an unexplained row.
    rows.push({
      kind: 'DELIVERY_BASE',
      label: 'Delivery fee',
      detail: null,
      amountMinor: quote.deliveryFeeMinor - deliveryDiscountMinor,
      ...(deliveryDiscountMinor > 0 ? { strikethroughMinor: quote.deliveryFeeMinor } : {}),
      included: false,
      negative: false,
    });
  }

  for (const fee of quote.fees) {
    if (fee.kind !== 'CHARGE' || fee.grossMinor === 0) {
      continue;
    }

    rows.push({
      kind: 'CHARGE',
      label: fee.label,
      detail: null,
      amountMinor: fee.grossMinor,
      included: false,
      negative: false,
    });
  }

  rows.push({
    kind: 'VAT',
    label: 'VAT',
    detail: `${quote.vatRate.mul(100).toFixed(0)}%, included`,
    amountMinor: quote.vatMinor,
    included: quote.pricesIncludeVat,
    negative: false,
  });

  rows.push({
    kind: 'TOTAL',
    label: 'To pay',
    detail: null,
    amountMinor: quote.totalMinor,
    included: false,
    negative: false,
  });

  return rows;
}

/**
 * Fails loudly if the rows do not reconstruct the total.
 *
 * The breakdown is what a customer checks an amount against and what staff read
 * back on the phone. A list that does not add up to the number charged is worse
 * than no list, so this is asserted rather than trusted.
 */
export function assertBreakdownAddsUp(rows: readonly BreakdownRow[]): void {
  const total = rows.find((row) => row.kind === 'TOTAL');

  if (!total) {
    throw new Error('Breakdown has no total row.');
  }

  // Every row now carries what is actually charged for it — a discount is a
  // strikethrough on the row it applied to, not a separate line to subtract —
  // so the rows simply add up.
  const sum = rows
    .filter((row) => row.kind !== 'TOTAL' && !row.included)
    .reduce((acc, row) => acc + (row.negative ? -row.amountMinor : row.amountMinor), 0);

  if (sum !== total.amountMinor) {
    throw new Error(`Breakdown does not add up: rows sum to ${sum}, total is ${total.amountMinor}`);
  }
}
