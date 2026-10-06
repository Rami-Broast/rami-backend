import { Minor, assertMinor, roundHalfAwayFromZero, sumMinor } from '../common/money';
import { BreakdownRow } from '../vat/order-breakdown';

/**
 * Turns one order's snapshotted, VAT-inclusive, post-discount breakdown into the
 * tax-exclusive line items a ZATCA invoice is built from.
 *
 * ## Why this is a separate, pure, tested function
 *
 * This platform prices everything **VAT-inclusive** and folds discounts into the
 * row they applied to (a strikethrough, never a negative line — see
 * `vat/order-breakdown.ts`). ZATCA invoices are the other way round: every line
 * carries a **tax-exclusive** unit price and a VAT percentage, and the tax is
 * added on top. So a value has to cross that boundary, and the one rule that
 * matters is that **the invoice's grand total must equal, to the halala, the
 * amount the customer was actually charged** — the `Order.totalMinor` snapshot.
 * An invoice that disagrees with the money captured is not a rounding nit; it is
 * a tax record that contradicts the bank.
 *
 * The conversion is therefore reconciled at the **document** level: each line's
 * tax-exclusive amount is derived from its inclusive amount, and the document
 * VAT is `capturedTotal − Σ(exclusive)`. Because the source rows already sum to
 * the captured total (the order engine's `assertBreakdownAddsUp` guarantees it),
 * the invoice total ties out exactly.
 *
 * Per-*line* VAT rounding is a different, smaller question: ZATCA recomputes each
 * line's VAT and rounds it, and for some amounts no single tax-exclusive integer
 * reproduces the inclusive amount exactly (e.g. 10.00 at 15%). That residual is
 * bounded by the line count in halalas, is a property of ZATCA's own rounding
 * rules, and is confirmed only by a passing compliance run against the ZATCA
 * `simulation` environment — never by this repository's tests (see
 * `restopos-zatca-service/README.md`). It is deliberately **not** forced here.
 * The mock adapter mirrors this same document-level reconciliation, so the demo
 * is internally exact end to end.
 */

/** One contributing amount from the order, VAT-inclusive and post-discount. */
export interface InvoiceSourceLine {
  /** Display name as it should read on the invoice, e.g. "Mixed Grill × 2". */
  name: string;
  /** VAT-inclusive amount in halalas, after any discount. Must be > 0. */
  grossMinor: Minor;
}

/** A ZATCA line item in the shape the RestoPOS external API accepts. */
export interface ZatcaInvoiceLine {
  id: string;
  name: string;
  /** Always 1: the line carries its whole aggregated amount as the unit price,
   * so `unitPrice` is exact to two decimals and no quantity multiplication can
   * reintroduce a rounding step. The real count lives in `name`. */
  quantity: 1;
  /** Tax-exclusive unit price in riyals (major units), exact to two decimals. */
  unitPrice: number;
  /** VAT percentage as an integer, e.g. 15. */
  vatPercent: number;
}

export interface BuiltInvoiceLines {
  lines: ZatcaInvoiceLine[];
  /** Sum of the lines' tax-exclusive amounts, in halalas. */
  totalExclusiveMinor: Minor;
  /** Reconciled document VAT = captured total − tax-exclusive total, in halalas. */
  totalVatMinor: Minor;
  /** Equals the captured `Order.totalMinor`, in halalas. */
  totalInclusiveMinor: Minor;
}

/**
 * Turns an order's snapshotted breakdown rows into invoice source lines.
 *
 * It takes exactly the rows that make up the total — everything that is not the
 * VAT line (which is `included`, i.e. already inside the total) and not the
 * grand-total row. Those rows are already **post-discount** (a discount is folded
 * into the row it applied to as a strikethrough, never a separate negative line),
 * so their amounts add straight up to the captured total.
 *
 * A negative contributing row would break that assumption — an invoice line
 * cannot be negative — so one is refused loudly rather than silently dropped.
 * The current pricing engine never emits one; this guards the day it might.
 */
export function sourceLinesFromBreakdown(rows: BreakdownRow[]): InvoiceSourceLine[] {
  const contributing = rows.filter(
    (row) => !row.included && row.kind !== 'TOTAL' && row.kind !== 'VAT',
  );
  return contributing.map((row) => {
    if (row.negative || row.amountMinor < 0) {
      throw new Error(
        `Breakdown row "${row.label}" is negative; a ZATCA invoice line cannot be negative.`,
      );
    }
    return {
      name: row.label + (row.detail ? ` (${row.detail})` : ''),
      grossMinor: row.amountMinor,
    };
  });
}

/** Tax-exclusive amount in halalas for a VAT-inclusive amount at `rate`. */
export function taxExclusiveMinor(grossInclusiveMinor: Minor, rate: number): Minor {
  assertMinor(grossInclusiveMinor, 'grossInclusiveMinor');
  return roundHalfAwayFromZero(grossInclusiveMinor / (1 + rate));
}

/**
 * Builds the invoice lines and reconciled document totals.
 *
 * @param sourceLines VAT-inclusive, post-discount contributing amounts (items,
 *   delivery, charges). Every amount must be a positive integer in halalas.
 * @param vatRate the snapshotted rate as a ratio, e.g. 0.15.
 * @param capturedTotalMinor the order's `totalMinor` — what was actually charged.
 * @throws if the source lines do not sum to `capturedTotalMinor`; a mismatch
 *   means the invoice would contradict the captured amount, which must fail loud
 *   rather than issue a wrong tax record.
 */
export function buildZatcaInvoiceLines(
  sourceLines: InvoiceSourceLine[],
  vatRate: number,
  capturedTotalMinor: Minor,
): BuiltInvoiceLines {
  assertMinor(capturedTotalMinor, 'capturedTotalMinor');
  if (!(vatRate >= 0) || vatRate >= 1) {
    throw new Error(`vatRate must be a ratio in [0, 1), received ${vatRate}`);
  }
  if (sourceLines.length === 0) {
    throw new Error('An invoice needs at least one line.');
  }

  const positiveLines = sourceLines.filter((line) => line.grossMinor !== 0);
  for (const line of positiveLines) {
    assertMinor(line.grossMinor, `line "${line.name}" grossMinor`);
    if (line.grossMinor < 0) {
      throw new Error(`Invoice line "${line.name}" is negative (${line.grossMinor}).`);
    }
  }

  const grossTotal = sumMinor(positiveLines.map((line) => line.grossMinor));
  if (grossTotal !== capturedTotalMinor) {
    throw new Error(
      `Invoice lines sum to ${grossTotal} but the captured total is ${capturedTotalMinor}. ` +
        'Refusing to issue an invoice that disagrees with the money charged.',
    );
  }

  const vatPercent = Math.round(vatRate * 100);
  const lines: ZatcaInvoiceLine[] = positiveLines.map((line, index) => {
    const exclusiveMinor = taxExclusiveMinor(line.grossMinor, vatRate);
    return {
      id: String(index + 1),
      name: line.name,
      quantity: 1 as const,
      unitPrice: exclusiveMinor / 100,
      vatPercent,
    };
  });

  const totalExclusiveMinor = sumMinor(lines.map((line) => Math.round(line.unitPrice * 100)));

  return {
    lines,
    totalExclusiveMinor,
    totalVatMinor: capturedTotalMinor - totalExclusiveMinor,
    totalInclusiveMinor: capturedTotalMinor,
  };
}
