import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, TaxClass } from '@prisma/client';

import {
  addVatExclusive,
  allocateProportionally,
  Minor,
  splitVatInclusive,
  sumMinor,
} from '../common/money';
import { AppConfigService } from '../config/app-config.service';
import {
  PricedAddon,
  PricedFee,
  PricedLine,
  PriceQuote,
  PricingRequest,
  ResolvedCharge,
  ResolvedLine,
} from './pricing.types';

const MAX_QUANTITY_PER_LINE = 999;

/**
 * The pricing and VAT engine.
 *
 * This is the **only** place the payable amount is decided. Clients display
 * what this returns; they never compute it. A client that sends a price is
 * ignored — the engine works from catalog data resolved server-side, so a
 * tampered request changes nothing about what is charged.
 *
 * ## How a total is built
 *
 * ```
 * items + modifiers + taxable fees − eligible discounts
 *   = taxable base → VAT → final total
 * ```
 *
 * ## Two decisions worth understanding
 *
 * **VAT is computed per line and then summed**, rather than computed once on
 * the order total. Invoices carry per-line tax, and a credit note has to mirror
 * the line it reverses. Deriving line tax by apportioning an order-level figure
 * reintroduces rounding differences at exactly the point where an auditor
 * checks the arithmetic.
 *
 * **Discounts are allocated across lines proportionally, by the
 * largest-remainder method**, so the parts sum to the discount exactly. Each
 * line's taxable base then reflects its own share, which keeps per-line VAT
 * correct on a discounted order — and keeps a partial refund of one line
 * computable without re-deriving the whole order.
 *
 * ## Rate and treatment
 *
 * The rate comes from configuration (0.15, confirmed) and is **snapshotted onto
 * every quote and every line**, so a future statutory change cannot rewrite
 * what a past customer was charged.
 *
 * Prices are treated as VAT-inclusive, matching Saudi consumer pricing: a menu
 * price of 32.50 already contains its tax, and the engine backs the tax out
 * rather than adding to it. Whether the delivery fee is taxable is
 * configurable; it is treated as part of the taxable supply by default.
 * Both treatments are recorded in ARCHITECTURE.md as requiring accountant
 * confirmation before production.
 */
@Injectable()
export class VatService {
  constructor(private readonly config: AppConfigService) {}

  /** The configured standard rate. Zero-rated and exempt classes use 0. */
  rateFor(taxClass: TaxClass): Prisma.Decimal {
    switch (taxClass) {
      case TaxClass.STANDARD:
        return this.config.pricing.standardVatRate;
      case TaxClass.ZERO_RATED:
      case TaxClass.EXEMPT:
        return new Prisma.Decimal(0);
    }
  }

  price(request: PricingRequest): PriceQuote {
    this.validate(request);

    const { pricesIncludeVat, deliveryFeeTaxable } = this.config.pricing;

    // 1. Gross each line, add-ons included. Nothing is discounted yet.
    const grossPerLine = request.lines.map((line) => this.grossOf(line));
    const subtotalMinor = sumMinor(grossPerLine);

    // 2. Split the requested discounts between items and delivery.
    const discounts = request.discounts ?? [];
    const itemDiscountRequested = sumMinor(
      discounts.filter((d) => d.appliesToDeliveryFee !== true).map((d) => d.amountMinor),
    );
    const deliveryDiscountRequested = sumMinor(
      discounts.filter((d) => d.appliesToDeliveryFee === true).map((d) => d.amountMinor),
    );

    // A discount can never exceed what it applies to. Without this clamp a
    // generous coupon on a small basket would produce a negative total — which
    // is to say, paying the customer to order.
    const itemDiscountMinor = Math.min(itemDiscountRequested, subtotalMinor);
    const deliveryDiscountMinor = Math.min(deliveryDiscountRequested, request.deliveryFeeMinor);

    // 3. Allocate the item discount across lines in proportion to their gross,
    //    so the parts sum to the discount exactly.
    const allocatedDiscounts = allocateProportionally(itemDiscountMinor, grossPerLine);

    // 4. Price each line off its own discounted gross.
    const lines = request.lines.map((line, index) =>
      this.priceLine(line, grossPerLine[index], allocatedDiscounts[index], pricesIncludeVat),
    );

    // 5. Delivery fee as its own line.
    const deliveryFees = this.priceDeliveryFee(
      request.deliveryFeeMinor,
      deliveryDiscountMinor,
      deliveryFeeTaxable,
      pricesIncludeVat,
    );

    // 6. Custom charges (service fee, packaging, etc.).
    const chargeFees = this.priceCharges(request.charges ?? [], pricesIncludeVat);
    const fees = [...deliveryFees, ...chargeFees];
    const chargesMinor = sumMinor(chargeFees.map((f) => f.grossMinor));

    const taxableBaseMinor =
      sumMinor(lines.map((line) => line.lineTaxableBaseMinor)) +
      sumMinor(fees.map((fee) => fee.taxableBaseMinor));

    const vatMinor =
      sumMinor(lines.map((line) => line.lineVatMinor)) + sumMinor(fees.map((fee) => fee.vatMinor));

    const totalMinor =
      sumMinor(lines.map((line) => line.lineTotalMinor)) +
      sumMinor(fees.map((fee) => fee.totalMinor));

    const quote: PriceQuote = {
      currency: request.currency,
      vatRate: this.config.pricing.standardVatRate,
      pricesIncludeVat,
      lines,
      fees,
      subtotalMinor,
      discountMinor: itemDiscountMinor + deliveryDiscountMinor,
      itemDiscountMinor,
      deliveryDiscountMinor,
      deliveryFeeMinor: request.deliveryFeeMinor,
      chargesMinor,
      taxableBaseMinor,
      vatMinor,
      totalMinor,
      appliedDiscounts: discounts,
    };

    this.assertInvariants(quote);

    return quote;
  }

  /**
   * The gross value of a set of lines, before any discount, fee or charge.
   *
   * Delivery pricing needs the item subtotal before it can decide the fee (the
   * minimum-order rule is measured on items alone), and the fee is then an
   * input to `price`. Exposing the same `grossOf` the engine uses keeps that
   * one number from being recomputed — slightly differently — outside it.
   */
  subtotalOf(lines: readonly ResolvedLine[]): Minor {
    return sumMinor(lines.map((line) => this.grossOf(line)));
  }

  private validate(request: PricingRequest): void {
    if (request.lines.length === 0) {
      throw new BadRequestException('An order must contain at least one item.');
    }

    for (const line of request.lines) {
      if (!Number.isInteger(line.quantity) || line.quantity < 1) {
        throw new BadRequestException('Item quantity must be a whole number of at least 1.');
      }

      if (line.quantity > MAX_QUANTITY_PER_LINE) {
        throw new BadRequestException(
          `Item quantity may not exceed ${MAX_QUANTITY_PER_LINE} per line.`,
        );
      }

      if (line.unitPriceMinor < 0) {
        throw new BadRequestException('A price may not be negative.');
      }
    }

    if (request.deliveryFeeMinor < 0) {
      throw new BadRequestException('The delivery fee may not be negative.');
    }

    for (const discount of request.discounts ?? []) {
      if (discount.amountMinor < 0) {
        throw new BadRequestException('A discount may not be negative.');
      }
    }

    for (const charge of request.charges ?? []) {
      if (charge.amountMinor < 0) {
        throw new BadRequestException('A charge may not be negative.');
      }
    }
  }

  /** Gross for a line: (unit price + add-ons) x quantity. */
  private grossOf(line: ResolvedLine): Minor {
    const addonsPerUnit = sumMinor(
      line.addons.map((addon) => addon.unitPriceMinor * addon.quantity),
    );

    return (line.unitPriceMinor + addonsPerUnit) * line.quantity;
  }

  private priceLine(
    line: ResolvedLine,
    grossMinor: Minor,
    discountMinor: Minor,
    pricesIncludeVat: boolean,
  ): PricedLine {
    const rate = this.rateFor(line.taxClass);
    const discountedGross = grossMinor - discountMinor;

    const { taxableBaseMinor, vatMinor, totalMinor } = this.splitCharge(
      discountedGross,
      rate,
      pricesIncludeVat,
    );

    const addons: PricedAddon[] = line.addons.map((addon) => ({
      addonId: addon.addonId,
      modifierGroupName: addon.modifierGroupName,
      addonName: addon.addonName,
      unitPriceMinor: addon.unitPriceMinor,
      quantity: addon.quantity,
      lineTotalMinor: addon.unitPriceMinor * addon.quantity * line.quantity,
    }));

    return {
      productId: line.productId,
      productVariantId: line.productVariantId,
      productName: line.productName,
      variantName: line.variantName,
      taxClass: line.taxClass,
      quantity: line.quantity,
      notes: line.notes,
      unitPriceMinor: line.unitPriceMinor,
      lineSubtotalMinor: grossMinor,
      lineDiscountMinor: discountMinor,
      lineTaxableBaseMinor: taxableBaseMinor,
      lineVatMinor: vatMinor,
      lineTotalMinor: totalMinor,
      vatRate: rate,
      addons,
    };
  }

  private priceDeliveryFee(
    feeMinor: Minor,
    discountMinor: Minor,
    taxable: boolean,
    pricesIncludeVat: boolean,
  ): PricedFee[] {
    if (feeMinor === 0) {
      return [];
    }

    const rate = taxable ? this.config.pricing.standardVatRate : new Prisma.Decimal(0);
    const discounted = feeMinor - discountMinor;

    const { taxableBaseMinor, vatMinor, totalMinor } = this.splitCharge(
      discounted,
      rate,
      pricesIncludeVat,
    );

    return [
      {
        kind: 'DELIVERY',
        label: 'Delivery fee',
        grossMinor: feeMinor,
        discountMinor,
        taxableBaseMinor,
        vatMinor,
        totalMinor,
        taxable,
      },
    ];
  }

  private priceCharges(charges: readonly ResolvedCharge[], pricesIncludeVat: boolean): PricedFee[] {
    return charges
      .filter((c) => c.amountMinor > 0)
      .map((charge) => {
        const rate = charge.taxable ? this.rateFor(charge.taxClass) : new Prisma.Decimal(0);

        const { taxableBaseMinor, vatMinor, totalMinor } = this.splitCharge(
          charge.amountMinor,
          rate,
          pricesIncludeVat,
        );

        return {
          kind: 'CHARGE' as const,
          chargeId: charge.chargeId,
          label: charge.name,
          labelAr: charge.nameAr,
          grossMinor: charge.amountMinor,
          discountMinor: 0,
          taxableBaseMinor,
          vatMinor,
          totalMinor,
          taxable: charge.taxable,
        };
      });
  }

  /**
   * Splits one charge into taxable base, VAT and total.
   *
   * Inclusive pricing backs the tax out of the amount; exclusive pricing adds
   * it on top. Either way the total is derived from the two parts, so they
   * always reconcile.
   */
  private splitCharge(
    amountMinor: Minor,
    rate: Prisma.Decimal,
    pricesIncludeVat: boolean,
  ): { taxableBaseMinor: Minor; vatMinor: Minor; totalMinor: Minor } {
    if (rate.isZero()) {
      return { taxableBaseMinor: amountMinor, vatMinor: 0, totalMinor: amountMinor };
    }

    if (pricesIncludeVat) {
      const { netMinor, vatMinor } = splitVatInclusive(amountMinor, rate);
      return { taxableBaseMinor: netMinor, vatMinor, totalMinor: amountMinor };
    }

    const { grossMinor, vatMinor } = addVatExclusive(amountMinor, rate);
    return { taxableBaseMinor: amountMinor, vatMinor, totalMinor: grossMinor };
  }

  /**
   * Fails loudly if a quote does not add up.
   *
   * A silent one-halala discrepancy between the lines and the total is exactly
   * what makes an invoice impossible to reconcile against a payment months
   * later. Better to refuse to produce the quote at all.
   */
  private assertInvariants(quote: PriceQuote): void {
    if (quote.taxableBaseMinor + quote.vatMinor !== quote.totalMinor) {
      throw new Error(
        `Pricing invariant violated: taxable base + VAT !== total ` +
          `(${quote.taxableBaseMinor} + ${quote.vatMinor} !== ${quote.totalMinor})`,
      );
    }

    const componentTotal =
      sumMinor(quote.lines.map((line) => line.lineTotalMinor)) +
      sumMinor(quote.fees.map((fee) => fee.totalMinor));

    if (componentTotal !== quote.totalMinor) {
      throw new Error(
        `Pricing invariant violated: components !== total ` +
          `(${componentTotal} !== ${quote.totalMinor})`,
      );
    }

    if (quote.totalMinor < 0) {
      throw new Error('Pricing invariant violated: total is negative');
    }
  }
}
