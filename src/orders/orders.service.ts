import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DeliveryStatus,
  DiscountKind,
  OrderStatus,
  OrderType,
  PaymentMethod,
  PaymentStatus,
  Prisma,
} from '@prisma/client';

import { Actor, isCustomer, isStaff } from '../auth/types/actor';
import { BranchHoursService } from '../branches/branch-hours.service';
import { assertBranchAccess, resolveRequestedBranches } from '../branches/branch-scope';
import { BranchOpenState, acceptsOrdersNow, formatMinute } from '../branches/opening-hours';
import { ChargesService } from '../charges/charges.service';
import { allocateProportionally } from '../common/money';
import { buildPaginationMeta } from '../common/dto/pagination.dto';
import { AppliedCoupon, CouponsService } from '../coupons/coupons.service';
import { AppliedPromotion, PromotionCartLine } from '../promotions/promotion-evaluation';
import { PromotionsService } from '../promotions/promotions.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { CatalogService } from '../menu/catalog.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.service';
import { DeliveryQuote } from '../delivery-pricing/delivery-pricing';
import { PrismaService } from '../prisma/prisma.service';
import { assertBreakdownAddsUp, buildOrderBreakdown } from '../vat/order-breakdown';
import { PriceQuote, ResolvedDiscount } from '../vat/pricing.types';
import { VatService } from '../vat/vat.service';
import { hasCapturedMoney } from '../payments/captured-money';
import {
  CancelOrderDto,
  CustomerCancelOrderDto,
  CounterOrderAddressDto,
  CounterOrderDto,
  ListOrdersQueryDto,
  MyOrdersQueryDto,
  PlaceOrderDto,
  QuoteOrderDto,
} from './dto/order.dto';
import { allocateOrderNumber, generateReferenceId } from './order-number';
import { canTransition, isCustomerCancellable, timestampFieldFor } from './order-status.machine';

/**
 * What to tell a customer whose branch is shut.
 *
 * A refusal is only useful if it answers the next question. "This branch is
 * closed" leaves someone staring at a full cart with nothing to do; "Closed —
 * opens at 17:00" tells them whether to wait or pick another branch, and a
 * holiday note tells them why today is different. The customer app leads
 * checkout with this rather than letting it arrive on the final press — the
 * same discipline the delivery blockers already follow.
 */
export function closedMessage(state: BranchOpenState): string {
  if (state.closedReason === 'override_closed' && state.note) {
    return `This branch is closed today — ${state.note}.`;
  }
  const opensAt = formatMinute(state.opensAtMinute);
  if (opensAt) {
    return `This branch is closed right now. It opens at ${opensAt}.`;
  }
  return 'This branch is closed right now.';
}

/** Non-gateway marker for the cash-on-delivery pseudo-payment. */
const CASH_ON_DELIVERY_GATEWAY = 'cash-on-delivery';

/** Non-gateway marker for cash taken at the branch counter (Branch POS). */
const COUNTER_CASH_GATEWAY = 'counter-cash';

/** Statuses that make up the live kitchen queue. */
const KITCHEN_QUEUE_STATUSES: OrderStatus[] = [
  OrderStatus.CONFIRMED,
  OrderStatus.PREPARING,
  OrderStatus.READY,
];

/** How many fresh reference ids to try before giving up on a collision. */
const REFERENCE_ID_ATTEMPTS = 5;

/** The shape every order response is loaded with. */
const orderInclude = {
  items: { include: { modifiers: true }, orderBy: { createdAt: 'asc' } },
  orderCharges: { orderBy: { createdAt: 'asc' } },
  // What each discount gave, so a receipt can name the offer rather than
  // printing one anonymous "Discount" for a promotion and a code together.
  discounts: { orderBy: { createdAt: 'asc' } },
  statusHistory: { orderBy: { createdAt: 'asc' } },
  branch: { select: { id: true, code: true, name: true, nameAr: true } },
  // `_count.orders` is how a docket can say "new customer" without a second
  // request per print. It counts this order too, so one order is a first
  // order — a client reading it must say so, rather than deriving anything
  // from its absence: an older backend omits it, and printing "new customer"
  // over a regular is the wrong that gets noticed at the counter.
  customer: {
    select: { id: true, phone: true, fullName: true, _count: { select: { orders: true } } },
  },
  // The names behind `couponId` / `promotionId`. A discount line reading
  // "Discount -15.00" tells a customer what left their basket but not what
  // gave it to them, and "20% off burgers" is the half they remember.
  coupon: { select: { id: true, code: true, name: true } },
  promotion: { select: { id: true, name: true } },
} satisfies Prisma.OrderInclude;

/**
 * The order engine (Phase 8).
 *
 * Turns a customer's cart into a priced, snapshotted order and governs how that
 * order moves through its fulfilment lifecycle. Two rules from the specification
 * shape everything here:
 *
 *   1. **The client never prices anything.** A cart is product IDs and
 *      quantities; the catalog resolves what those cost and the VAT engine
 *      decides the payable total. What the engine returns is snapshotted onto
 *      the order verbatim, so a later menu-price change can never rewrite what a
 *      customer was charged.
 *
 *   2. **Fulfilment and money are separate.** `Order.status` moves through the
 *      kitchen and delivery; `Order.paymentStatus` tracks money. Neither is
 *      derived from the other. Cash on delivery is the clearest case: the order
 *      is CONFIRMED and cooked while payment stays PENDING until the driver
 *      collects it.
 *
 * Branch isolation is enforced on every staff path: a branch admin or kitchen
 * user sees and touches only their assigned branches; an owner sees all.
 * Customers reach only their own orders, by customer id.
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly vat: VatService,
    private readonly notifications: NotificationsService,
    private readonly coupons: CouponsService,
    private readonly promotions: PromotionsService,
    private readonly loyalty: LoyaltyService,
    private readonly realtime: RealtimeService,
    private readonly charges: ChargesService,
    private readonly hours: BranchHoursService,
  ) {}

  /**
   * Pushes the realtime order event that matches a status.
   *
   * `AWAITING_ACCEPTANCE` is the New Orders tray's cue (`order.awaiting`);
   * every other status is a generic `order.transitioned`. Best-effort and
   * post-commit — the RealtimeService swallows its own failures, so this can
   * never break the flow that called it.
   */
  private pushOrderEvent(order: {
    id: string;
    orderNumber: string;
    referenceId?: string;
    branchId: string;
    status: OrderStatus;
    customerId: string;
  }): void {
    const payload = {
      orderId: order.id,
      orderNumber: order.orderNumber,
      referenceId: order.referenceId,
      branchId: order.branchId,
      status: order.status,
      customerId: order.customerId,
    };
    if (order.status === OrderStatus.AWAITING_ACCEPTANCE) {
      this.realtime.orderAwaiting(payload);
    }
    this.realtime.orderTransitioned(payload);
  }

  // ===========================================================================
  // Creation
  // ===========================================================================

  /**
   * Previews the price of a cart for the authenticated customer.
   *
   * Two kinds of discount can land here and they behave differently on purpose:
   * a **coupon** is a code the customer typed, and an **automatic promotion** is
   * a standing offer that applies to a qualifying cart whether or not anyone
   * asked. The promotion is therefore evaluated on every quote, including the
   * first render of the checkout screen.
   *
   * They stack — see {@link resolveDiscount}. Both are evaluated, both are
   * applied, and the engine's clamp is what keeps a pair of generous discounts
   * from taking an order below zero.
   *
   * Read-only: it never records coupon usage, so the authoritative and atomic
   * application still happens in {@link placeOrder}. An invalid or ineligible
   * coupon does not fail the quote — the base price is returned with a
   * `couponError` message the app can show, so the totals never disappear while
   * the customer fixes the code.
   */
  async quoteForCustomer(actor: Actor, dto: QuoteOrderDto) {
    if (!isCustomer(actor)) {
      throw new ForbiddenException('Only a customer can request a quote.');
    }

    const lines = await this.catalog.resolveCartLines(dto.branchId, dto.items, dto.type);
    // The delivery fee depends on the item subtotal (the minimum-order rule)
    // and on how far the drop-off is, so it is priced after the lines and
    // before the engine that consumes it.
    const delivery = await this.catalog.quoteDelivery(
      dto.branchId,
      dto.type,
      await this.deliveryDestination(actor.id, dto.customerAddressId),
      this.vat.subtotalOf(lines),
    );
    const deliveryFeeMinor = delivery?.deliveryFeeMinor ?? 0;
    const itemCount = dto.items.reduce((n, i) => n + i.quantity, 0);

    const resolvedCharges = await this.charges.resolveForOrder({
      branchId: dto.branchId,
      subtotalMinor: 0,
      deliveryFeeMinor,
      itemCount,
      orderType: dto.type,
      at: new Date(),
    });

    const base = this.vat.price({
      currency: 'SAR',
      lines,
      deliveryFeeMinor,
      charges: resolvedCharges,
    });

    const chargesForQuote = await this.charges.resolveForOrder({
      branchId: dto.branchId,
      subtotalMinor: base.subtotalMinor,
      deliveryFeeMinor,
      itemCount,
      orderType: dto.type,
      at: new Date(),
    });

    // The standing offer, evaluated whether or not a code was typed: a
    // promotion is a discount nobody asks for, so a cart that qualifies gets it
    // even on the very first render of the checkout screen.
    const promotion = await this.promotions.evaluateForCart({
      branchId: dto.branchId,
      lines: this.promotionLines(base),
      subtotalMinor: base.subtotalMinor,
      deliveryFeeMinor,
    });

    let coupon: AppliedCoupon | null = null;
    let couponError: string | null = null;

    if (dto.couponCode) {
      try {
        coupon = await this.coupons.evaluate({
          code: dto.couponCode,
          customerId: actor.id,
          branchId: dto.branchId,
          subtotalMinor: base.subtotalMinor,
          deliveryFeeMinor,
          productIds: lines.map((line) => line.productId).filter((id): id is string => Boolean(id)),
        });
      } catch (error) {
        // A bad code must not take the totals down with it. The customer is
        // mid-checkout; they need to see what they are paying while they fix it.
        if (!(error instanceof BadRequestException)) throw error;
        couponError = error.message;
      }
    }

    const applied = this.resolveDiscount(coupon, promotion);

    const quote = this.vat.price({
      currency: 'SAR',
      lines,
      deliveryFeeMinor,
      ...(applied.discounts.length > 0 ? { discounts: applied.discounts } : {}),
      charges: chargesForQuote,
    });

    // Whether the branch is even open, on the quote rather than at the final
    // press. It is the same discipline the delivery blockers already follow:
    // the moment a customer most needs to know they cannot order is *before*
    // they have chosen what to eat, and a refusal that arrives on the Pay
    // button has already wasted the whole visit. A quote never throws — the
    // totals stay on screen while the customer decides what to do about it.
    const openState = await this.hours.openState(dto.branchId);

    return {
      quote,
      delivery,
      branchOpen: {
        isOpen: acceptsOrdersNow(openState),
        closedReason: openState.closedReason,
        note: openState.note,
        opensAt: formatMinute(openState.opensAtMinute),
        closesAt: formatMinute(openState.closesAtMinute),
        message: acceptsOrdersNow(openState) ? null : closedMessage(openState),
      },
      breakdown: buildOrderBreakdown(quote, delivery),
      coupon: applied.coupon
        ? {
            code: dto.couponCode as string,
            couponId: applied.coupon.couponId,
            // The offer's name, so the bill can say what took the money off
            // rather than only quoting a code back at the customer.
            name: applied.coupon.name,
            discountMinor: applied.coupon.discountMinor,
          }
        : null,
      couponError,
      // The same question for a discount the customer never asked for: an
      // unexplained saving gets queried as often as an unexplained charge.
      promotion: applied.promotion
        ? {
            promotionId: applied.promotion.promotionId,
            name: applied.promotion.name,
            discountMinor: applied.promotion.discountMinor,
          }
        : null,
      couponSuperseded: applied.couponSuperseded,
    };
  }

  /**
   * Places an order for the authenticated customer.
   *
   * The whole write is one transaction: order, items, modifiers, the initial
   * status-history row and — for cash on delivery — the pending payment record
   * and the confirmation transition all commit together, or none do.
   */
  async placeOrder(actor: Actor, dto: PlaceOrderDto) {
    if (!isCustomer(actor)) {
      // This endpoint is the customer app. Staff placing a walk-in / phone
      // order on a customer's behalf go through placeOrderForStaff instead.
      throw new ForbiddenException('Only a customer can place an order.');
    }

    const settings = await this.loadOrderableBranch(dto.branchId, dto.type, true);

    if (dto.paymentMethod === PaymentMethod.CASH_ON_DELIVERY && !settings.acceptsCashOnDelivery) {
      throw new BadRequestException('This branch does not accept cash on delivery.');
    }

    const deliveryAddress = await this.resolveDeliveryAddress(actor.id, dto);
    const customerAddressId = deliveryAddress?.id ?? null;

    // Server-side pricing. Every price is read from the catalog; nothing the
    // client sent about money is consulted.
    const lines = await this.catalog.resolveCartLines(dto.branchId, dto.items, dto.type);
    const delivery = await this.catalog.quoteDelivery(
      dto.branchId,
      dto.type,
      deliveryAddress,
      this.vat.subtotalOf(lines),
    );
    // A quote never refuses; a placement must. This is where a basket below
    // the minimum, or an address outside the radius, stops being information
    // and becomes a rejection.
    this.catalog.assertDeliverable(delivery);
    const deliveryFeeMinor = delivery?.deliveryFeeMinor ?? 0;

    // Resolve custom charges (service fees, packaging, etc.) for this order
    // context. Charges are evaluated before the coupon so the subtotal used for
    // coupon eligibility does not include charges — charges are on top.
    const resolvedCharges = await this.charges.resolveForOrder({
      branchId: dto.branchId,
      subtotalMinor: 0, // placeholder — re-evaluated after base price
      deliveryFeeMinor,
      itemCount: dto.items.reduce((n, i) => n + i.quantity, 0),
      orderType: dto.type,
      paymentMethod: dto.paymentMethod,
      at: new Date(),
    });

    // Price once to know the item subtotal, then evaluate any coupon against it,
    // then price again with the resulting discount. The coupon module decides
    // eligibility and the amount; the VAT engine remains the only place a total
    // is computed.
    const base = this.vat.price({
      currency: 'SAR',
      lines,
      deliveryFeeMinor,
      charges: resolvedCharges,
    });

    // Re-resolve charges now that we have the real subtotal.
    const chargesForOrder = await this.charges.resolveForOrder({
      branchId: dto.branchId,
      subtotalMinor: base.subtotalMinor,
      deliveryFeeMinor,
      itemCount: dto.items.reduce((n, i) => n + i.quantity, 0),
      orderType: dto.type,
      paymentMethod: dto.paymentMethod,
      at: new Date(),
    });

    // Deliberately delivery-only. `minOrderMinor` is the *delivery* minimum
    // (40 SAR, owner 2026-09-04); applying it to pickup would refuse a walk-in
    // buying one coffee. The delivery case is already refused above, with a
    // message that says how much more to add — this remains as the guard for a
    // subtotal that changed between the two, and for a coupon-less path.
    if (dto.type === OrderType.DELIVERY && base.subtotalMinor < settings.minOrderMinor) {
      throw new BadRequestException("The order is below this branch's minimum for its items.");
    }

    // The standing offer. Evaluated on every placement, code or no code: a
    // promotion is not claimed, it applies.
    const promotion = await this.promotions.evaluateForCart({
      branchId: dto.branchId,
      lines: this.promotionLines(base),
      subtotalMinor: base.subtotalMinor,
      deliveryFeeMinor,
    });

    // A quote tolerates a bad code; a placement does not. By the time someone
    // presses Pay the code has already been shown as accepted or rejected, so a
    // failure here is a coupon that changed underneath them and the order must
    // stop rather than quietly cost more than the screen said.
    let evaluatedCoupon: AppliedCoupon | null = null;
    if (dto.couponCode) {
      evaluatedCoupon = await this.coupons.evaluate({
        code: dto.couponCode,
        customerId: actor.id,
        branchId: dto.branchId,
        subtotalMinor: base.subtotalMinor,
        deliveryFeeMinor,
        productIds: lines.map((line) => line.productId).filter((id): id is string => Boolean(id)),
      });
    }

    const applied = this.resolveDiscount(evaluatedCoupon, promotion);
    const appliedCoupon = applied.coupon;

    const quote = this.vat.price({
      currency: 'SAR',
      lines,
      deliveryFeeMinor,
      ...(applied.discounts.length > 0 ? { discounts: applied.discounts } : {}),
      charges: chargesForOrder,
    });

    const isCod = dto.paymentMethod === PaymentMethod.CASH_ON_DELIVERY;

    const placed = await this.createWithUniqueReference((referenceId) =>
      this.prisma.$transaction(async (tx) => {
        const order = await tx.order.create({
          data: {
            orderNumber: await allocateOrderNumber(tx, dto.branchId),
            referenceId,
            branchId: dto.branchId,
            customerId: actor.id,
            customerAddressId,
            couponId: appliedCoupon?.couponId ?? null,
            promotionId: applied.promotion?.promotionId ?? null,
            type: dto.type,
            status: OrderStatus.PENDING_PAYMENT,
            paymentStatus: PaymentStatus.PENDING,
            currency: quote.currency,
            subtotalMinor: quote.subtotalMinor,
            discountMinor: quote.discountMinor,
            deliveryFeeMinor: quote.deliveryFeeMinor,
            chargesMinor: quote.chargesMinor,
            taxableBaseMinor: quote.taxableBaseMinor,
            vatMinor: quote.vatMinor,
            totalMinor: quote.totalMinor,
            vatRate: quote.vatRate,
            priceBreakdown: this.serializeQuote(quote, delivery),
            scheduledFor: dto.scheduledFor ? new Date(dto.scheduledFor) : null,
            customerNotes: dto.customerNotes,
            items: { create: this.buildItems(quote) },
            statusHistory: {
              create: {
                fromStatus: null,
                toStatus: OrderStatus.PENDING_PAYMENT,
                changedByCustomerId: actor.id,
                reason: 'Order placed',
              },
            },
          },
        });

        if (chargesForOrder.length > 0) {
          await this.createOrderCharges(tx, order.id, quote);
        }

        await this.createOrderDiscounts(tx, order.id, quote, appliedCoupon, applied.promotion);

        // Consume the coupon inside the same transaction. The atomic guard and
        // the unique orderId make reuse impossible even under concurrent
        // checkouts; if the coupon was exhausted since evaluation, this throws
        // and the whole order rolls back.
        if (appliedCoupon) {
          await this.coupons.recordUsage(
            tx,
            appliedCoupon.couponId,
            actor.id,
            order.id,
            appliedCoupon.discountMinor,
          );
        }

        if (isCod) {
          // The record that money is owed and how it will be collected. It is a
          // real Payment so settlement and reporting see COD alongside gateway
          // takings, but it goes through no gateway — hence the marker name.
          await tx.payment.create({
            data: {
              orderId: order.id,
              status: PaymentStatus.PENDING,
              method: PaymentMethod.CASH_ON_DELIVERY,
              currency: quote.currency,
              amountMinor: quote.totalMinor,
              gatewayName: CASH_ON_DELIVERY_GATEWAY,
            },
          });

          // COD needs no upfront payment. A branch on auto-accept goes
          // straight to CONFIRMED (kitchen); a branch on manual-accept parks
          // in AWAITING_ACCEPTANCE so staff can eyeball it first. Payment
          // stays PENDING — the two columns move independently.
          const initialStatus = settings.autoAcceptOrders
            ? OrderStatus.CONFIRMED
            : OrderStatus.AWAITING_ACCEPTANCE;
          await this.applyTransition(tx, order, initialStatus, actor, {
            reason: settings.autoAcceptOrders
              ? 'Confirmed — cash on delivery'
              : 'Awaiting branch acceptance — cash on delivery',
          });
        }

        return tx.order.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
      }),
    );

    // Post-commit: a COD order was confirmed on placement, so notify the
    // customer. An online order stays PENDING_PAYMENT and is notified when its
    // payment is confirmed (Phase 11).
    if (placed.status !== OrderStatus.PENDING_PAYMENT) {
      await this.notifications.onOrderStatus(placed.id, placed.status);
    }
    // Realtime: light up the New Orders tray the instant an order lands
    // (AWAITING_ACCEPTANCE or CONFIRMED). An online order that is still
    // PENDING_PAYMENT is not yet actionable for staff, so nothing is pushed
    // until its payment confirms it via the transition path below.
    if (placed.status !== OrderStatus.PENDING_PAYMENT) {
      this.pushOrderEvent(placed);
    }

    return placed;
  }

  /**
   * Places an order at the branch counter, for a walk-in or phone customer
   * (Branch POS).
   *
   * The differences from {@link placeOrder} are only in *who* and *how paid* —
   * the money discipline is identical: the cart is resolved and priced entirely
   * server-side and snapshotted, never taken from the request. Specifically:
   *
   *   - **Branch isolation.** The order's branch is asserted against the caller's
   *     scope, so a branch member can only take orders for their own branch.
   *   - **The customer is identified by phone**, not by being the caller. An
   *     existing customer is reused; a new one is created (unverified — they have
   *     not logged in). A phone order for delivery gets its address saved inline.
   *   - **Payment is settled at the counter.** CASH creates a paid-or-pending
   *     cash payment; CASH_ON_DELIVERY behaves exactly like the customer COD
   *     path. Card/online payment stays the customer app's flow.
   *
   * A counter order is taken in person, so — like COD — it enters the branch
   * flow immediately (CONFIRMED, or AWAITING_ACCEPTANCE on a manual-accept
   * branch); fulfilment and payment move independently, so an unpaid cash order
   * is still cooked.
   */
  async placeOrderForStaff(actor: Actor, dto: CounterOrderDto) {
    if (!isStaff(actor)) {
      throw new ForbiddenException('Only staff can place a counter order.');
    }
    assertBranchAccess(actor, dto.branchId);

    // Hours are not enforced here: see `loadOrderableBranch`. Staff placing
    // this order can see the shop.
    const settings = await this.loadOrderableBranch(dto.branchId, dto.type, false);

    const isCod = dto.paymentMethod === PaymentMethod.CASH_ON_DELIVERY;
    if (isCod) {
      if (dto.type !== OrderType.DELIVERY) {
        throw new BadRequestException('Cash on delivery applies to delivery orders only.');
      }
      if (!settings.acceptsCashOnDelivery) {
        throw new BadRequestException('This branch does not accept cash on delivery.');
      }
    }

    if (dto.type === OrderType.DELIVERY && !dto.deliveryAddress) {
      throw new BadRequestException('A delivery address is required for a delivery order.');
    }

    const customer = await this.resolveCounterCustomer(dto.customerPhone, dto.customerName);

    // Persist the entered address so the normal delivery leg (snapshot at READY,
    // driver assignment) works unchanged and it is reused on the next order.
    const counterAddress =
      dto.type === OrderType.DELIVERY
        ? await this.createCounterAddress(
            customer.id,
            dto.deliveryAddress as CounterOrderAddressDto,
          )
        : null;
    const customerAddressId = counterAddress?.id ?? null;

    // Server-side pricing, identical discipline to the customer path.
    const lines = await this.catalog.resolveCartLines(dto.branchId, dto.items, dto.type);
    const delivery = await this.catalog.quoteDelivery(
      dto.branchId,
      dto.type,
      counterAddress,
      this.vat.subtotalOf(lines),
    );
    this.catalog.assertDeliverable(delivery);
    const deliveryFeeMinor = delivery?.deliveryFeeMinor ?? 0;

    const chargesForOrder = await this.charges.resolveForOrder({
      branchId: dto.branchId,
      subtotalMinor: 0,
      deliveryFeeMinor,
      itemCount: dto.items.reduce((n, i) => n + i.quantity, 0),
      orderType: dto.type,
      paymentMethod: dto.paymentMethod,
      at: new Date(),
    });

    const base = this.vat.price({
      currency: 'SAR',
      lines,
      deliveryFeeMinor,
      charges: chargesForOrder,
    });

    // Re-resolve charges with the real subtotal.
    const chargesWithSubtotal = await this.charges.resolveForOrder({
      branchId: dto.branchId,
      subtotalMinor: base.subtotalMinor,
      deliveryFeeMinor,
      itemCount: dto.items.reduce((n, i) => n + i.quantity, 0),
      orderType: dto.type,
      paymentMethod: dto.paymentMethod,
      at: new Date(),
    });

    // Deliberately delivery-only. `minOrderMinor` is the *delivery* minimum
    // (40 SAR, owner 2026-09-04); applying it to pickup would refuse a walk-in
    // buying one coffee. The delivery case is already refused above, with a
    // message that says how much more to add — this remains as the guard for a
    // subtotal that changed between the two, and for a coupon-less path.
    if (dto.type === OrderType.DELIVERY && base.subtotalMinor < settings.minOrderMinor) {
      throw new BadRequestException("The order is below this branch's minimum for its items.");
    }

    // The standing offer. Evaluated on every placement, code or no code: a
    // promotion is not claimed, it applies.
    const promotion = await this.promotions.evaluateForCart({
      branchId: dto.branchId,
      lines: this.promotionLines(base),
      subtotalMinor: base.subtotalMinor,
      deliveryFeeMinor,
    });

    // A quote tolerates a bad code; a placement does not. By the time someone
    // presses Pay the code has already been shown as accepted or rejected, so a
    // failure here is a coupon that changed underneath them and the order must
    // stop rather than quietly cost more than the screen said.
    let evaluatedCoupon: AppliedCoupon | null = null;
    if (dto.couponCode) {
      evaluatedCoupon = await this.coupons.evaluate({
        code: dto.couponCode,
        customerId: customer.id,
        branchId: dto.branchId,
        subtotalMinor: base.subtotalMinor,
        deliveryFeeMinor,
        productIds: lines.map((line) => line.productId).filter((id): id is string => Boolean(id)),
      });
    }

    const applied = this.resolveDiscount(evaluatedCoupon, promotion);
    const appliedCoupon = applied.coupon;

    const quote = this.vat.price({
      currency: 'SAR',
      lines,
      deliveryFeeMinor,
      ...(applied.discounts.length > 0 ? { discounts: applied.discounts } : {}),
      charges: chargesWithSubtotal,
    });

    // Cash taken up front (a walk-in paying now) is recorded PAID; a phone order
    // paid on collection, and COD, stay PENDING. This is the merchant's own
    // record of a counter sale by an authenticated staff member — not a client
    // claiming a gateway succeeded, which is the rule that keeps online payment
    // honest and does not apply to cash physically taken at the till.
    const cashPaidNow = dto.paymentMethod === PaymentMethod.CASH && dto.cashCollected === true;

    const placed = await this.createWithUniqueReference((referenceId) =>
      this.prisma.$transaction(async (tx) => {
        const order = await tx.order.create({
          data: {
            orderNumber: await allocateOrderNumber(tx, dto.branchId),
            referenceId,
            branchId: dto.branchId,
            customerId: customer.id,
            customerAddressId,
            couponId: appliedCoupon?.couponId ?? null,
            promotionId: applied.promotion?.promotionId ?? null,
            type: dto.type,
            status: OrderStatus.PENDING_PAYMENT,
            paymentStatus: cashPaidNow ? PaymentStatus.PAID : PaymentStatus.PENDING,
            currency: quote.currency,
            subtotalMinor: quote.subtotalMinor,
            discountMinor: quote.discountMinor,
            deliveryFeeMinor: quote.deliveryFeeMinor,
            chargesMinor: quote.chargesMinor,
            taxableBaseMinor: quote.taxableBaseMinor,
            vatMinor: quote.vatMinor,
            totalMinor: quote.totalMinor,
            vatRate: quote.vatRate,
            priceBreakdown: this.serializeQuote(quote, delivery),
            scheduledFor: dto.scheduledFor ? new Date(dto.scheduledFor) : null,
            customerNotes: dto.customerNotes,
            items: { create: this.buildItems(quote) },
            statusHistory: {
              create: {
                fromStatus: null,
                toStatus: OrderStatus.PENDING_PAYMENT,
                changedByUserId: actor.id,
                reason: 'Counter order placed',
              },
            },
          },
        });

        if (chargesWithSubtotal.length > 0) {
          await this.createOrderCharges(tx, order.id, quote);
        }

        await this.createOrderDiscounts(tx, order.id, quote, appliedCoupon, applied.promotion);

        if (appliedCoupon) {
          await this.coupons.recordUsage(
            tx,
            appliedCoupon.couponId,
            customer.id,
            order.id,
            appliedCoupon.discountMinor,
          );
        }

        // A real Payment so settlement and reporting see the counter takings.
        // Its own gateway marker keeps it out of any gateway payout (settlements
        // are scoped per gatewayName); reports group by method, so cash shows as
        // its own line.
        await tx.payment.create({
          data: {
            orderId: order.id,
            status: cashPaidNow ? PaymentStatus.PAID : PaymentStatus.PENDING,
            method: dto.paymentMethod,
            currency: quote.currency,
            amountMinor: quote.totalMinor,
            capturedAmountMinor: cashPaidNow ? quote.totalMinor : 0,
            capturedAt: cashPaidNow ? new Date() : null,
            gatewayName: isCod ? CASH_ON_DELIVERY_GATEWAY : COUNTER_CASH_GATEWAY,
          },
        });

        const initialStatus = settings.autoAcceptOrders
          ? OrderStatus.CONFIRMED
          : OrderStatus.AWAITING_ACCEPTANCE;
        await this.applyTransition(tx, order, initialStatus, actor, {
          reason: settings.autoAcceptOrders
            ? 'Confirmed — counter order'
            : 'Awaiting branch acceptance — counter order',
        });

        return tx.order.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
      }),
    );

    // Post-commit side effects, all best-effort (see placeOrder).
    await this.notifications.onOrderStatus(placed.id, placed.status);
    this.pushOrderEvent(placed);

    return placed;
  }

  // ===========================================================================
  // Customer reads and self-service
  // ===========================================================================

  async listForCustomer(actor: Actor, query: MyOrdersQueryDto) {
    const where: Prisma.OrderWhereInput = {
      customerId: actor.id,
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        include: orderInclude,
        orderBy: { placedAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.order.count({ where }),
    ]);

    return { data, meta: buildPaginationMeta(total, query) };
  }

  /** One of the customer's own orders, with its full status history for tracking. */
  async getForCustomer(actor: Actor, id: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, customerId: actor.id, deletedAt: null },
      include: orderInclude,
    });

    // A not-found response whether the order is absent or simply someone else's
    // — a customer must not be able to probe for other customers' order ids.
    if (!order) {
      throw new NotFoundException('Order not found.');
    }

    return order;
  }

  /**
   * A customer cancelling their own order outright.
   *
   * **Only while nothing has been paid** (owner decision, 2026-09-08). Money is
   * the gate, not time: an unpaid order costs the branch nothing to drop, but
   * the moment a payment has been captured, cancelling means giving money back
   * — and that is the branch's decision, made through a refund request. So a
   * paid order is refused here however early it is, and pointed at the request.
   *
   * The rule is enforced here rather than only in the eligibility read the apps
   * call: a client that skipped the check, or held a stale one, must still be
   * refused by the server.
   */
  async cancelByCustomer(actor: Actor, id: string, dto: CustomerCancelOrderDto) {
    const order = await this.prisma.order.findFirst({
      where: { id, customerId: actor.id, deletedAt: null },
    });

    if (!order) {
      throw new NotFoundException('Order not found.');
    }

    if (!isCustomerCancellable(order.status)) {
      throw new ConflictException(
        'This order can no longer be cancelled. Please contact the branch.',
      );
    }

    if (hasCapturedMoney(order.paymentStatus)) {
      throw new ConflictException(
        'You’ve paid for this order, so the branch has to approve cancelling it and returning your money. Ask them from your order screen.',
      );
    }

    const cancelled = await this.prisma.$transaction((tx) =>
      this.applyTransitionAndReturn(tx, order.id, OrderStatus.CANCELLED, actor, {
        // The customer's own words, verbatim. The status-history row already
        // records that a customer made the change, so prefixing it would only
        // push the part a branch actually reads further along the line.
        reason: dto.reason,
      }),
    );

    await this.notifications.onOrderStatus(cancelled.id, OrderStatus.CANCELLED);
    await this.loyalty.reverseAllForOrder(cancelled.id, 'Order cancelled by customer');
    this.pushOrderEvent(cancelled);

    return cancelled;
  }

  // ===========================================================================
  // Staff reads
  // ===========================================================================

  /**
   * Turns a staff search box into a `where` fragment.
   *
   * A branch looking an order up has one of three things to hand: the 12-digit
   * reference off the customer's docket, the branch order number, or the phone
   * the customer is calling from. All three are matched from the start of the
   * value, so a reference read out over a bad line and typed in half still
   * narrows the list.
   *
   * This is only ever ANDed into a query that already carries the caller's
   * branch scope, so it can widen *what* is matched but never *whose* — a
   * branch user searching another branch's reference finds nothing.
   */
  private orderSearchFilter(search: string | undefined): Prisma.OrderWhereInput {
    const term = search?.trim();
    if (!term) {
      return {};
    }

    return {
      OR: [
        { referenceId: { startsWith: term } },
        { orderNumber: { startsWith: term } },
        { customer: { phone: { startsWith: term } } },
      ],
    };
  }

  async listForStaff(actor: Actor, query: ListOrdersQueryDto) {
    const where: Prisma.OrderWhereInput = {
      deletedAt: null,
      // Branch isolation: an owner may name any branch or none; branch staff are
      // restricted to their assignments whether they name a branch or not.
      ...resolveRequestedBranches(actor, query.branchId),
      ...(query.status ? { status: query.status } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...this.orderSearchFilter(query.search),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        include: orderInclude,
        orderBy: { placedAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.order.count({ where }),
    ]);

    return { data, meta: buildPaginationMeta(total, query) };
  }

  async getForStaff(actor: Actor, id: string) {
    const order = await this.loadForStaff(actor, id);

    return this.prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
  }

  /** Orders parked awaiting a branch human's accept/reject decision. */
  async awaitingAcceptanceQueue(actor: Actor, branchId: string) {
    assertBranchAccess(actor, branchId);

    return this.prisma.order.findMany({
      where: {
        branchId,
        deletedAt: null,
        status: OrderStatus.AWAITING_ACCEPTANCE,
      },
      include: orderInclude,
      orderBy: { placedAt: 'asc' },
    });
  }

  /** The live kitchen queue for one branch, oldest first. */
  async kitchenQueue(actor: Actor, branchId: string) {
    assertBranchAccess(actor, branchId);

    return this.prisma.order.findMany({
      where: {
        branchId,
        deletedAt: null,
        status: { in: KITCHEN_QUEUE_STATUSES },
      },
      include: orderInclude,
      orderBy: { placedAt: 'asc' },
    });
  }

  // ===========================================================================
  // Staff transitions
  // ===========================================================================

  /** Branch accepts an order that was parked in AWAITING_ACCEPTANCE. */
  accept(actor: Actor, id: string) {
    return this.staffTransition(actor, id, OrderStatus.CONFIRMED, undefined, {
      reason: 'Accepted by branch',
    });
  }

  /**
   * Branch rejects an order that was parked in AWAITING_ACCEPTANCE. The reason
   * is required and recorded on the status-history entry, per spec §7.
   * Cancelling triggers refund on any online-paid order via the existing
   * cancel flow — this method does the same via applyTransition → CANCELLED.
   */
  reject(actor: Actor, id: string, reason: string) {
    return this.staffTransition(actor, id, OrderStatus.CANCELLED, undefined, {
      reason: `Rejected by branch: ${reason}`,
    });
  }

  markPreparing(actor: Actor, id: string) {
    return this.staffTransition(actor, id, OrderStatus.PREPARING);
  }

  markReady(actor: Actor, id: string) {
    return this.staffTransition(actor, id, OrderStatus.READY);
  }

  /** Marks a pickup order collected by the customer. Delivery orders are handled by the delivery module. */
  async completePickup(actor: Actor, id: string) {
    const order = await this.loadForStaff(actor, id);

    if (order.type !== OrderType.PICKUP) {
      throw new BadRequestException(
        'Only pickup orders are completed here. A delivery order is completed by its delivery.',
      );
    }

    return this.staffTransition(actor, id, OrderStatus.DELIVERED, order);
  }

  async cancelByStaff(actor: Actor, id: string, dto: CancelOrderDto) {
    return this.staffTransition(actor, id, OrderStatus.CANCELLED, undefined, {
      reason: dto.reason ?? 'Cancelled by staff',
    });
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  /**
   * Loads a branch that can currently take an order of the requested type, or
   * throws a specific reason why it cannot. Kept as one place so the customer
   * app gets a consistent, actionable refusal.
   */
  private async loadOrderableBranch(
    branchId: string,
    type: OrderType,
    /**
     * Whether the branch's opening hours are enforced.
     *
     * **True for a customer, false at the counter**, and the asymmetry is
     * deliberate. `isAcceptingOrders` is a switch someone flips; opening hours
     * are a schedule that runs whether anyone is watching, which is the point
     * of having them — an owner should not have to remember to close the shop
     * every night. But staff taking a walk-in are standing in the shop: if the
     * schedule says shut and there is a customer at the counter, the schedule
     * is what is wrong, and refusing the sale to defend it would be the app
     * arguing with the room.
     */
    enforceHours: boolean,
  ) {
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, isActive: true, deletedAt: null },
      include: { settings: true },
    });

    if (!branch) {
      throw new NotFoundException('Branch not found.');
    }

    const settings = branch.settings;

    if (!settings || !settings.isAcceptingOrders) {
      throw new BadRequestException('This branch is not accepting orders right now.');
    }

    if (type === OrderType.DELIVERY && !settings.acceptsDelivery) {
      throw new BadRequestException('This branch does not offer delivery.');
    }

    if (type === OrderType.PICKUP && !settings.acceptsPickup) {
      throw new BadRequestException('This branch does not offer pickup.');
    }

    if (enforceHours) {
      const open = await this.hours.openState(branchId);
      if (!acceptsOrdersNow(open)) {
        throw new BadRequestException(closedMessage(open));
      }
    }

    return settings;
  }

  /**
   * For a delivery order, resolves and validates the delivery address; for a
   * pickup order, ensures none was supplied by mistake.
   */
  private async resolveDeliveryAddress(
    customerId: string,
    dto: PlaceOrderDto,
  ): Promise<{ id: string; latitude: number | null; longitude: number | null } | null> {
    if (dto.type === OrderType.PICKUP) {
      return null;
    }

    if (!dto.customerAddressId) {
      throw new BadRequestException('A delivery address is required for delivery orders.');
    }

    const address = await this.prisma.customerAddress.findFirst({
      where: { id: dto.customerAddressId, customerId, deletedAt: null },
      select: { id: true, latitude: true, longitude: true },
    });

    // Scoped to this customer, so one customer cannot deliver to — or probe for
    // — another customer's saved address.
    if (!address) {
      throw new BadRequestException('The selected delivery address was not found.');
    }

    // The coordinates come back with the id because the delivery fee is priced
    // from them. An address saved without a pin has none, and the fee falls
    // back to the base — see priceDelivery.
    return {
      id: address.id,
      latitude: address.latitude?.toNumber() ?? null,
      longitude: address.longitude?.toNumber() ?? null,
    };
  }

  /**
   * Coordinates for a quote's chosen address, or null.
   *
   * A quote is a preview: a customer who has not picked an address yet still
   * gets totals, priced at the base fee, rather than an error.
   */
  private async deliveryDestination(
    customerId: string,
    customerAddressId: string | undefined,
  ): Promise<{ latitude: number | null; longitude: number | null } | null> {
    if (!customerAddressId) {
      return null;
    }

    const address = await this.prisma.customerAddress.findFirst({
      where: { id: customerAddressId, customerId, deletedAt: null },
      select: { latitude: true, longitude: true },
    });

    if (!address) {
      return null;
    }

    return {
      latitude: address.latitude?.toNumber() ?? null,
      longitude: address.longitude?.toNumber() ?? null,
    };
  }

  /**
   * Finds the customer for a counter order by phone, creating one if none
   * exists. A created customer is unverified — they have not logged in — which
   * is exactly right: staff took the order on their behalf. Handles the rare
   * concurrent-create race by re-reading on the unique-phone clash.
   */
  private async resolveCounterCustomer(phone: string, fullName?: string) {
    const existing = await this.prisma.customer.findUnique({ where: { phone } });
    if (existing) {
      if (existing.deletedAt) {
        throw new ConflictException(
          'A customer with this phone number is deactivated. Reactivate them before ordering.',
        );
      }
      return existing;
    }

    try {
      return await this.prisma.customer.create({ data: { phone, fullName: fullName ?? null } });
    } catch (error) {
      // Two counter orders for a brand-new phone at once: the loser of the race
      // reads the row the winner just created rather than failing the order.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        this.targetIncludes(error, 'phone')
      ) {
        const raced = await this.prisma.customer.findUnique({ where: { phone } });
        if (raced && !raced.deletedAt) {
          return raced;
        }
      }
      throw error;
    }
  }

  /**
   * Saves an address entered at the counter as one of the customer's addresses,
   * returning its id. Created outside the order transaction so a reference-id
   * retry never duplicates it; a stray unused address on the rare order failure
   * is harmless and reusable.
   */
  private async createCounterAddress(
    customerId: string,
    address: CounterOrderAddressDto,
  ): Promise<{ id: string; latitude: number | null; longitude: number | null }> {
    const created = await this.prisma.customerAddress.create({
      data: {
        customerId,
        label: address.label ?? null,
        line1: address.line1,
        line2: address.line2 ?? null,
        district: address.district ?? null,
        city: address.city,
        postalCode: address.postalCode ?? null,
        notes: address.notes ?? null,
        latitude: address.latitude ?? null,
        longitude: address.longitude ?? null,
      },
      select: { id: true, latitude: true, longitude: true },
    });

    return {
      id: created.id,
      latitude: created.latitude?.toNumber() ?? null,
      longitude: created.longitude?.toNumber() ?? null,
    };
  }

  /** Maps a priced quote onto OrderItem create input, snapshotting every line. */
  /**
   * The cart as a promotion sees it: which product, and what its line is worth.
   *
   * Taken from the engine's own priced lines rather than recomputed, so a
   * promotion is measured against exactly the gross the customer is charged —
   * add-ons, variants, the delivery uplift and all. Recomputing it here would be
   * a second implementation of `grossOf`, and the day the two disagreed the
   * discount would be right on one screen and wrong on the bill.
   */
  private promotionLines(base: PriceQuote): PromotionCartLine[] {
    return base.lines.map((line) => ({
      productId: line.productId,
      grossMinor: line.lineSubtotalMinor,
    }));
  }

  /**
   * Puts together the discounts that apply to a cart.
   *
   * **A coupon and an automatic promotion stack** (owner decision,
   * 2026-09-10). They did not until now: the engine charged whichever was
   * worth more and told the customer their code had been superseded. The owner
   * has decided a customer who both qualifies for a standing offer and holds a
   * code gets both.
   *
   * Two things that decision does not change, and which are what keep it from
   * running away:
   *
   *  - **The engine clamps.** A discount can never exceed what it applies to,
   *    so two generous discounts on a small basket take the basket to zero and
   *    no further — never to a negative total, which is to say paying the
   *    customer to order.
   *  - **Nothing compounds.** Each discount is an amount resolved against the
   *    *undiscounted* gross, so two 20% offers take 40% off, not 36%. Whether
   *    that is the intended generosity is an owner question, not an arithmetic
   *    one, and this is the one place it is decided.
   *
   * `couponSuperseded` therefore has nothing left to report and is always
   * null. It stays on the response because clients render it; a field that
   * quietly changes meaning is worse than one that goes quiet.
   */
  private resolveDiscount(
    coupon: AppliedCoupon | null,
    promotion: AppliedPromotion | null,
  ): {
    coupon: AppliedCoupon | null;
    promotion: AppliedPromotion | null;
    discounts: ResolvedDiscount[];
    couponSuperseded: string | null;
  } {
    // The promotion first, so that where the clamp cuts a stacked pair down it
    // cuts the code the customer typed rather than the offer the branch
    // advertised — the offer is a price the branch published to everybody.
    const discounts: ResolvedDiscount[] = [];
    if (promotion) {
      discounts.push(promotion.discount);
    }
    if (coupon) {
      discounts.push(coupon.discount);
    }

    return { coupon, promotion, discounts, couponSuperseded: null };
  }

  private buildItems(quote: PriceQuote): Prisma.OrderItemCreateWithoutOrderInput[] {
    return quote.lines.map((line) => ({
      productId: line.productId ?? null,
      productVariantId: line.productVariantId ?? null,
      productName: line.productName,
      variantName: line.variantName ?? null,
      taxClass: line.taxClass,
      unitPriceMinor: line.unitPriceMinor,
      quantity: line.quantity,
      lineSubtotalMinor: line.lineSubtotalMinor,
      lineDiscountMinor: line.lineDiscountMinor,
      lineVatMinor: line.lineVatMinor,
      lineTotalMinor: line.lineTotalMinor,
      notes: line.notes ?? null,
      modifiers: {
        create: line.addons.map((addon) => ({
          addonId: addon.addonId ?? null,
          modifierGroupName: addon.modifierGroupName,
          addonName: addon.addonName,
          unitPriceMinor: addon.unitPriceMinor,
          quantity: addon.quantity,
          lineTotalMinor: addon.lineTotalMinor,
        })),
      },
    }));
  }

  /**
   * Records what each discount actually gave, beside `Order.discountMinor`.
   *
   * The aggregate cannot answer "which offer saved me this?" for a customer,
   * nor "where did this giveaway come from?" for the owner — and since a
   * coupon and a promotion may now both apply to one order, `couponId` and
   * `promotionId` cannot answer it either.
   *
   * **The amounts recorded are the ones the customer was given, not the ones
   * the discounts asked for.** The engine clamps a discount to what it applies
   * to, so a pair asking for more than the basket is worth is cut down;
   * recording the request would put a giveaway on the books that never
   * happened, and the rows would not sum to `discountMinor`. The clamped total
   * is split back across the discounts in proportion to what each asked for,
   * with the same allocator the engine uses on lines, so the parts sum exactly.
   */
  private async createOrderDiscounts(
    tx: Prisma.TransactionClient,
    orderId: string,
    quote: PriceQuote,
    coupon: AppliedCoupon | null,
    promotion: AppliedPromotion | null,
  ): Promise<void> {
    const applied: {
      kind: DiscountKind;
      couponId: string | null;
      promotionId: string | null;
      label: string;
      requestedMinor: number;
      appliesToDeliveryFee: boolean;
    }[] = [];

    if (promotion) {
      applied.push({
        kind: DiscountKind.PROMOTION,
        couponId: null,
        promotionId: promotion.promotionId,
        label: promotion.name,
        requestedMinor: promotion.discount.amountMinor,
        appliesToDeliveryFee: promotion.discount.appliesToDeliveryFee === true,
      });
    }
    if (coupon) {
      applied.push({
        kind: DiscountKind.COUPON,
        couponId: coupon.couponId,
        promotionId: null,
        label: coupon.name ?? coupon.discount.source,
        requestedMinor: coupon.discount.amountMinor,
        appliesToDeliveryFee: coupon.discount.appliesToDeliveryFee === true,
      });
    }
    if (applied.length === 0) {
      return;
    }

    // Item and delivery discounts are clamped against different things, so
    // they are shared out separately.
    const rows = (['items', 'delivery'] as const).flatMap((bucket) => {
      const inBucket = applied.filter((d) =>
        bucket === 'delivery' ? d.appliesToDeliveryFee : !d.appliesToDeliveryFee,
      );
      if (inBucket.length === 0) {
        return [];
      }
      const given = allocateProportionally(
        bucket === 'delivery' ? quote.deliveryDiscountMinor : quote.itemDiscountMinor,
        inBucket.map((d) => d.requestedMinor),
      );
      return inBucket.map((d, index) => ({
        orderId,
        kind: d.kind,
        couponId: d.couponId,
        promotionId: d.promotionId,
        label: d.label,
        amountMinor: given[index] ?? 0,
        appliesToDeliveryFee: d.appliesToDeliveryFee,
      }));
    });

    // A discount clamped to nothing is not a discount. Recording a zero row
    // would put a line reading "-0.00" on the customer's receipt.
    const paying = rows.filter((row) => row.amountMinor > 0);
    if (paying.length > 0) {
      await tx.orderDiscount.createMany({ data: paying });
    }
  }

  private async createOrderCharges(
    tx: Prisma.TransactionClient,
    orderId: string,
    quote: PriceQuote,
  ): Promise<void> {
    const chargeFees = quote.fees.filter((f) => f.kind === 'CHARGE');
    if (chargeFees.length === 0) return;

    await tx.orderCharge.createMany({
      data: chargeFees.map((f) => ({
        orderId,
        chargeId: f.chargeId ?? null,
        name: f.label,
        nameAr: f.labelAr ?? null,
        grossMinor: f.grossMinor,
        vatMinor: f.vatMinor,
        totalMinor: f.totalMinor,
        taxable: f.taxable,
      })),
    });
  }

  /**
   * The full pricing-engine output, as plain JSON for the order's audit
   * snapshot. `Prisma.Decimal` fields serialise to strings via their `toJSON`,
   * so the round-trip yields a clean JSON object with no class instances.
   */
  /**
   * Snapshots the priced quote, the delivery calculation behind it, and the
   * itemised breakdown onto the order.
   *
   * The breakdown is stored, not derived on read, for the same reason the
   * prices are: the branch's fee rules will change, and an order re-explained
   * six months later under today's rules would show a fee it was never
   * charged. What the customer saw is what is kept.
   */
  private serializeQuote(quote: PriceQuote, delivery: DeliveryQuote | null): Prisma.InputJsonValue {
    const rows = buildOrderBreakdown(quote, delivery);
    assertBreakdownAddsUp(rows);

    return JSON.parse(
      JSON.stringify({ ...quote, delivery, breakdown: rows }),
    ) as Prisma.InputJsonValue;
  }

  /**
   * Runs `create` with a generated 12-digit reference, retrying on the rare
   * unique collision with a fresh one. The database constraint — not this
   * retry — is what guarantees uniqueness; the retry just turns a
   * 1-in-billions clash into a transparent second attempt instead of an error.
   *
   * The *order number* needs no such retry: it is allocated inside the
   * transaction by `allocateOrderNumber`, which the database serialises per
   * branch.
   */
  private async createWithUniqueReference<T>(
    create: (referenceId: string) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= REFERENCE_ID_ATTEMPTS; attempt += 1) {
      try {
        return await create(generateReferenceId());
      } catch (error) {
        const isReferenceClash =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002' &&
          this.targetIncludes(error, 'referenceId');

        if (!isReferenceClash || attempt === REFERENCE_ID_ATTEMPTS) {
          throw error;
        }
      }
    }

    // Unreachable: the loop either returns or throws.
    throw new ConflictException('Could not allocate an order reference. Please retry.');
  }

  private targetIncludes(error: Prisma.PrismaClientKnownRequestError, column: string): boolean {
    const target: unknown = error.meta?.target;
    if (Array.isArray(target)) {
      return target.some((entry) => typeof entry === 'string' && entry.includes(column));
    }
    return typeof target === 'string' && target.includes(column);
  }

  /** Loads an order for a staff caller and asserts branch access. */
  private async loadForStaff(actor: Actor, id: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, deletedAt: null },
    });

    if (!order) {
      throw new NotFoundException('Order not found.');
    }

    assertBranchAccess(actor, order.branchId);

    return order;
  }

  /**
   * Loads, access-checks and transitions an order in one step, returning the
   * fully-loaded result. `preloaded` lets a caller that already fetched and
   * access-checked the order skip the second read.
   */
  private async staffTransition(
    actor: Actor,
    id: string,
    toStatus: OrderStatus,
    preloaded?: { id: string; branchId: string; status: OrderStatus; type: OrderType },
    opts: { reason?: string } = {},
  ) {
    const order = preloaded ?? (await this.loadForStaff(actor, id));

    if (!preloaded) {
      assertBranchAccess(actor, order.branchId);
    }

    const result = await this.prisma.$transaction((tx) =>
      this.applyTransitionAndReturn(tx, order.id, toStatus, actor, opts),
    );

    // Post-commit side effects, all best-effort.
    await this.notifications.onOrderStatus(result.id, toStatus);
    this.pushOrderEvent(result);

    if (toStatus === OrderStatus.DELIVERED) {
      await this.loyalty.earnForOrder(result.id);
    } else if (toStatus === OrderStatus.CANCELLED) {
      await this.loyalty.reverseAllForOrder(result.id, 'Order cancelled');
    }

    return result;
  }

  private async applyTransitionAndReturn(
    tx: Prisma.TransactionClient,
    id: string,
    toStatus: OrderStatus,
    actor: Actor,
    opts: { reason?: string },
  ) {
    const order = await tx.order.findUniqueOrThrow({
      where: { id },
      select: { id: true, status: true, type: true },
    });

    await this.applyTransition(tx, order, toStatus, actor, opts);

    return tx.order.findUniqueOrThrow({ where: { id }, include: orderInclude });
  }

  /**
   * The single choke point for a status change.
   *
   * Validates the move against the state machine, stamps the matching timestamp,
   * records the cancellation reason where relevant and appends an append-only
   * status-history row attributing the change to whoever made it. Every
   * transition — customer, staff, or a future module — goes through here, so the
   * rules cannot be bypassed.
   */
  async applyTransition(
    tx: Prisma.TransactionClient,
    order: { id: string; status: OrderStatus; type: OrderType },
    toStatus: OrderStatus,
    // `null` attributes the change to the system — a verified payment webhook or
    // a scheduled job, where there is no human actor to record.
    actor: Actor | null,
    opts: { reason?: string } = {},
  ): Promise<void> {
    if (!canTransition(order.status, toStatus, order.type)) {
      throw new ConflictException(`An order cannot move from ${order.status} to ${toStatus}.`);
    }

    const timestampField = timestampFieldFor(toStatus);
    const data: Prisma.OrderUpdateInput = {
      status: toStatus,
      ...(timestampField ? { [timestampField]: new Date() } : {}),
      ...(toStatus === OrderStatus.CANCELLED ? { cancellationReason: opts.reason ?? null } : {}),
    };

    // Conditional on the status we just validated, so the check and the write
    // are one atomic step.
    //
    // An unconditional update here is not safe. Under READ COMMITTED two
    // concurrent callers both read the same status, both pass `canTransition`,
    // and both write — which is how an order ended up CONFIRMED while carrying
    // `cancelledAt` and a cancellation reason, with both moves in its history.
    // Zero rows updated means someone else moved the order between our read and
    // our write, so this caller's move was decided against a status that no
    // longer holds and must be refused rather than applied on top.
    //
    // Same shape as the coupon claim in `CouponsService.recordUsage` — the
    // database, not application code, is what serialises the two writers.
    const { count } = await tx.order.updateMany({
      where: { id: order.id, status: order.status },
      data,
    });

    if (count === 0) {
      throw new ConflictException('This order has already moved on. Refresh and try again.');
    }

    await tx.orderStatusHistory.create({
      data: {
        orderId: order.id,
        fromStatus: order.status,
        toStatus,
        changedByUserId: actor && isStaff(actor) ? actor.id : null,
        changedByCustomerId: actor && isCustomer(actor) ? actor.id : null,
        reason: opts.reason,
      },
    });

    // Delivery is a later module (Phase 14), but the cascades below belong at
    // this choke point rather than in it: every path that reaches READY or
    // CANCELLED — customer cancel, staff cancel, staff markReady — must carry
    // them, and putting them here means the delivery module never has to
    // duplicate this rule or risk missing a caller.
    if (order.type === OrderType.DELIVERY) {
      if (toStatus === OrderStatus.READY) {
        await this.createDeliveryRecord(tx, order.id);
      } else if (toStatus === OrderStatus.CANCELLED) {
        await this.cancelDeliveryRecord(tx, order.id);
      }
    }
  }

  /**
   * Opens the delivery leg for an order reaching READY, if one is not already
   * open. Snapshots the delivery address the same way order placement
   * snapshots prices — a customer editing or deleting the saved address later
   * must not change where an in-flight order goes.
   */
  private async createDeliveryRecord(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
    const existing = await tx.delivery.findUnique({ where: { orderId }, select: { id: true } });
    if (existing) {
      return;
    }

    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { branchId: true, customerAddressId: true },
    });

    // Every delivery order requires an address at placement (see
    // resolveDeliveryAddress); a missing one here would mean the order was
    // never a real delivery order, so there is nothing to open.
    if (!order.customerAddressId) {
      return;
    }

    const address = await tx.customerAddress.findUnique({ where: { id: order.customerAddressId } });
    if (!address) {
      return;
    }

    const created = await tx.delivery.create({
      data: {
        orderId,
        branchId: order.branchId,
        status: DeliveryStatus.PENDING_ASSIGNMENT,
        addressSnapshot: {
          label: address.label,
          line1: address.line1,
          line2: address.line2,
          district: address.district,
          city: address.city,
          postalCode: address.postalCode,
          latitude: address.latitude ? address.latitude.toNumber() : null,
          longitude: address.longitude ? address.longitude.toNumber() : null,
          notes: address.notes,
        },
      },
    });

    await tx.deliveryStatusHistory.create({
      data: {
        deliveryId: created.id,
        fromStatus: null,
        toStatus: DeliveryStatus.PENDING_ASSIGNMENT,
      },
    });
  }

  /**
   * Cancels an order's delivery leg alongside the order, if one exists and has
   * not already left the pre-pickup states. The order state machine only
   * allows CANCELLED up to and including DRIVER_ASSIGNED, so a delivery here is
   * always PENDING_ASSIGNMENT or ASSIGNED — never mid-route.
   */
  private async cancelDeliveryRecord(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
    const delivery = await tx.delivery.findUnique({ where: { orderId } });
    if (!delivery || !DELIVERY_CANCELLABLE.has(delivery.status)) {
      return;
    }

    await tx.delivery.update({
      where: { id: delivery.id },
      data: { status: DeliveryStatus.CANCELLED, cancelledAt: new Date() },
    });

    await tx.deliveryStatusHistory.create({
      data: {
        deliveryId: delivery.id,
        fromStatus: delivery.status,
        toStatus: DeliveryStatus.CANCELLED,
      },
    });

    if (delivery.driverId) {
      // Free the driver up again — the job they were holding capacity for no
      // longer exists.
      await tx.driver.update({ where: { id: delivery.driverId }, data: { isAvailable: true } });
    }
  }
}

/** Delivery states from which cancelling the order should also cancel the delivery. */
const DELIVERY_CANCELLABLE: ReadonlySet<DeliveryStatus> = new Set([
  DeliveryStatus.PENDING_ASSIGNMENT,
  DeliveryStatus.ASSIGNED,
]);
