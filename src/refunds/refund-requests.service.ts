import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  NotificationType,
  OrderStatus,
  PaymentStatus,
  Prisma,
  RefundRequestStatus,
  RefundRequestType,
  RefundStatus,
} from '@prisma/client';

import { AUDIT_ACTIONS, AUDIT_ENTITIES } from '../audit/audit-actions';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { AppConfigService } from '../config/app-config.service';
import { Actor, isCustomer, isStaff } from '../auth/types/actor';
import { assertBranchAccess, resolveRequestedBranches } from '../branches/branch-scope';
import { buildPaginationMeta } from '../common/dto/pagination.dto';
import { NotificationsService } from '../notifications/notifications.service';
import {
  refundIssuedMessage,
  refundRequestApprovedMessage,
  refundRequestReceivedMessage,
  refundRequestRejectedMessage,
} from '../notifications/notification-messages';
import { canTransition } from '../orders/order-status.machine';
import { OrdersService } from '../orders/orders.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ApproveRefundRequestDto,
  CreateRefundRequestDto,
  ListRefundRequestsQueryDto,
  MyRefundRequestsQueryDto,
  RecordRefundIssuedDto,
  RejectRefundRequestDto,
} from './dto/refund-request.dto';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { ZatcaInvoicingService } from '../zatca-invoicing/zatca-invoicing.service';
import { RefundRequestEligibility, refundRequestEligibility } from './refund-request-eligibility';

/** What actually happened when a request was approved. */
export type ApprovalOutcome =
  /**
   * Money is owed and the owner pays it out in the gateway's own dashboard.
   *
   * Owner decision: **approving does not call the gateway.** The branch decides,
   * the owner issues the refund in Tap and records it here with the reference.
   * So an approval of this kind is a debt, not a payment — which is exactly why
   * `refundIssuedAt` exists and why no screen may call this "refunded".
   */
  | 'AWAITING_PAYOUT'
  /**
   * There was money to give back but it never went through a gateway — cash at
   * the counter, or cash on delivery. The branch settles it in person. Recorded
   * as approved with no `Refund` row, because a refund row for money nobody
   * moved would be a lie about the money.
   */
  | 'MANUAL_SETTLEMENT'
  /** The order was stopped; nothing had been captured, so nothing goes back. */
  | 'CANCELLED_NO_REFUND';

const requestView = {
  id: true,
  orderId: true,
  customerId: true,
  branchId: true,
  type: true,
  status: true,
  reason: true,
  resolutionNote: true,
  reviewedByUserId: true,
  reviewedAt: true,
  refundId: true,
  orderCancelled: true,
  approvedAmountMinor: true,
  refundIssuedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.RefundRequestSelect;

const staffRequestView = {
  ...requestView,
  order: {
    select: {
      orderNumber: true,
      referenceId: true,
      status: true,
      paymentStatus: true,
      totalMinor: true,
      currency: true,
      placedAt: true,
      deliveredAt: true,
    },
  },
  customer: { select: { id: true, fullName: true, phone: true } },
  reviewedByUser: { select: { id: true, fullName: true, email: true } },
  refund: {
    select: {
      id: true,
      amountMinor: true,
      status: true,
      currency: true,
      gatewayReference: true,
      issuedManually: true,
    },
  },
} satisfies Prisma.RefundRequestSelect;

const customerRequestView = {
  ...requestView,
  order: {
    select: { orderNumber: true, referenceId: true, totalMinor: true, currency: true },
  },
  refund: { select: { id: true, amountMinor: true, status: true, currency: true } },
} satisfies Prisma.RefundRequestSelect;

/**
 * Refund and cancellation **requests** — the customer's side of a refund.
 *
 * A customer could already cancel an order themselves, but only while it sat in
 * PENDING_PAYMENT / AWAITING_ACCEPTANCE / CONFIRMED. Past that the API said
 * "Please contact the branch" and the platform held nothing at all: no request,
 * no queue, no record of the ask. Whether anything happened depended on somebody
 * remembering a phone call, and the customer had no way to see what had been
 * decided.
 *
 * **Three parties, three acts** (owner decision):
 *
 *   1. The **customer** asks, inside the owner's window.
 *   2. The **branch** decides — `refund-requests:decide`. Approving records what
 *      is owed and, for a cancellation, stops the order.
 *   3. The **owner** pays out in the payment gateway's own dashboard and records
 *      it here — `refunds:write`, owner-only.
 *
 * Two rules shape everything:
 *
 *   - **Approving is not paying.** This service never calls the gateway. An
 *     approved request with `refundIssuedAt` null is a **debt**, and no screen
 *     may call it refunded. `recordRefundIssued` is the act that writes a
 *     `Refund`, moves the money columns and tells the customer — because until
 *     then none of those things have happened.
 *   - **Cancelling goes through the order engine.** Approving a cancellation
 *     calls `OrdersService.cancelByStaff`, so the state machine, the status
 *     history, the delivery record and the loyalty reversal all behave exactly
 *     as they do for any other cancellation. Nothing here mutates
 *     `Order.status`.
 *
 * `RefundsService.createRefund` (the gateway path) is untouched and still the
 * only way a refund is *requested through a gateway*. It comes back into use
 * the day the real Tap adapter lands; until then the owner's dashboard is the
 * gateway, and `Refund.issuedManually` is how the two are told apart.
 *
 * The dependency runs refunds → orders, never back, the same shape as delivery.
 */
@Injectable()
export class RefundRequestsService {
  private readonly logger = new Logger(RefundRequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly notifications: NotificationsService,
    private readonly loyalty: LoyaltyService,
    private readonly config: AppConfigService,
    private readonly zatca: ZatcaInvoicingService,
    private readonly audit: AuditRecorder,
  ) {}

  // ===========================================================================
  // Customer
  // ===========================================================================

  /**
   * Whether this customer may ask about this order, and what to call it.
   *
   * A separate read rather than a field on the order because the answer moves on
   * its own — an order crosses out of self-cancellable, a refund starts, a
   * window shuts — and a client that cached it with the order would offer a
   * button the server then refuses.
   */
  async eligibilityForCustomer(actor: Actor, orderId: string): Promise<RefundRequestEligibility> {
    const order = await this.loadOwnOrder(actor, orderId);
    const eligibility = this.eligibilityOf(order);

    await this.recordWindowMiss(order, eligibility);

    return eligibility;
  }

  /**
   * Notes a customer who arrived after their window shut.
   *
   * **The only reason this exists is that the refusal is otherwise invisible.**
   * An approved or declined request leaves a row somebody can read; a customer
   * told "the window has closed" leaves nothing, because the rule refuses
   * before anything is written. So a window that is too short would never
   * announce itself — it would surface as phone calls to branches, and the
   * platform would go on reporting that refunds were working fine.
   *
   * Best-effort in every direction: swallowed on failure, and unique per order
   * so re-opening the screen is not counted as another turned-away customer. It
   * must never be the reason a customer cannot read their own order.
   */
  private async recordWindowMiss(
    order: { id: string; customerId: string; branchId: string },
    eligibility: RefundRequestEligibility,
  ): Promise<void> {
    if (eligibility.blocker !== 'WINDOW_CLOSED' || !eligibility.windowClosesAt) {
      return;
    }

    const type = eligibility.type ?? RefundRequestType.REFUND;
    const windowMinutes =
      type === RefundRequestType.CANCELLATION
        ? this.config.refunds.cancellationWindowMinutes
        : this.config.refunds.requestWindowMinutes;

    try {
      await this.prisma.refundWindowMiss.create({
        data: {
          orderId: order.id,
          customerId: order.customerId,
          branchId: order.branchId,
          type,
          minutesLate: Math.max(
            0,
            Math.floor((Date.now() - eligibility.windowClosesAt.getTime()) / 60_000),
          ),
          // Snapshotted, so a later change to the policy cannot silently rewrite
          // what an old row meant.
          windowMinutes: windowMinutes ?? 0,
        },
      });
    } catch (error) {
      // P2002 is the ordinary case — this order has already been counted.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
        this.logger.warn(
          `Could not record a refund-window miss for order ${order.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  async createForCustomer(actor: Actor, orderId: string, dto: CreateRefundRequestDto) {
    const order = await this.loadOwnOrder(actor, orderId);

    const eligibility = this.eligibilityOf(order);

    if (!eligibility.canRequest || !eligibility.type) {
      // The eligibility message is the customer-facing sentence for every
      // blocker, so the refusal a client shows is the same one it would have
      // shown before the button was pressed.
      throw new ConflictException(eligibility.message);
    }

    const created = await this.prisma.refundRequest
      .create({
        data: {
          orderId: order.id,
          customerId: order.customerId,
          branchId: order.branchId,
          type: eligibility.type,
          reason: dto.reason,
        },
        select: customerRequestView,
      })
      .catch(async (error: unknown) => {
        // The partial unique index on (orderId) WHERE status = 'PENDING' is what
        // actually stops a double-tap from filing the same complaint twice; the
        // check above can be passed by two concurrent requests. Return the one
        // that won rather than an error the customer cannot act on.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          return this.prisma.refundRequest.findFirstOrThrow({
            where: { orderId: order.id, status: RefundRequestStatus.PENDING },
            select: customerRequestView,
          });
        }
        throw error;
      });

    // Post-commit and best-effort, like every other notification trigger: a
    // failed SMS must never lose the request.
    await this.notifications.dispatch(
      order.id,
      NotificationType.REFUND_UPDATE,
      refundRequestReceivedMessage({
        orderNumber: order.orderNumber,
        branchName: order.branch.name,
      }),
    );

    return created;
  }

  async listForCustomer(actor: Actor, query: MyRefundRequestsQueryDto) {
    if (!isCustomer(actor)) {
      throw new ForbiddenException('Only customers may list their own requests.');
    }

    const where: Prisma.RefundRequestWhereInput = {
      customerId: actor.id,
      ...(query.status ? { status: query.status } : {}),
      // Always ANDed onto the customer's own id, so this widens *what* is
      // matched and never *whose* — the same discipline as the staff search.
      ...(query.orderId ? { orderId: query.orderId } : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.refundRequest.findMany({
        where,
        select: customerRequestView,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.refundRequest.count({ where }),
    ]);

    return { data, meta: buildPaginationMeta(total, query) };
  }

  /** A customer changing their mind before anyone has decided. */
  async withdrawForCustomer(actor: Actor, id: string) {
    if (!isCustomer(actor)) {
      throw new ForbiddenException('Only customers may withdraw their own requests.');
    }

    const request = await this.prisma.refundRequest.findFirst({
      where: { id, customerId: actor.id },
      select: { id: true, status: true },
    });

    // Same "not found" whether it is absent or someone else's, so ids cannot be
    // probed — the rule the customer order routes already follow.
    if (!request) {
      throw new NotFoundException('Request not found.');
    }

    if (request.status !== RefundRequestStatus.PENDING) {
      throw new ConflictException('This request has already been decided.');
    }

    return this.prisma.refundRequest.update({
      where: { id: request.id },
      data: { status: RefundRequestStatus.WITHDRAWN },
      select: customerRequestView,
    });
  }

  // ===========================================================================
  // Staff
  // ===========================================================================

  async listForStaff(actor: Actor, query: ListRefundRequestsQueryDto) {
    const where: Prisma.RefundRequestWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.orderId ? { orderId: query.orderId } : {}),
      // The owner's payout queue: approved, and the money not yet sent. Two
      // conditions, because "approved" alone is not a debt — half of them are
      // already paid.
      ...(query.awaitingPayout !== undefined
        ? {
            status: RefundRequestStatus.APPROVED,
            refundIssuedAt: query.awaitingPayout ? null : { not: null },
          }
        : {}),
      ...resolveRequestedBranches(actor, query.branchId),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.refundRequest.findMany({
        where,
        select: staffRequestView,
        // Oldest first within the open queue is what a branch works, but a
        // mixed list reads better newest-first; status is the filter that makes
        // the queue, so the ordering stays one rule.
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.refundRequest.count({ where }),
    ]);

    return { data, meta: buildPaginationMeta(total, query) };
  }

  async getForStaff(actor: Actor, id: string) {
    const request = await this.prisma.refundRequest.findFirst({
      where: { id },
      select: staffRequestView,
    });

    if (!request) {
      throw new NotFoundException('Request not found.');
    }

    assertBranchAccess(actor, request.branchId);

    return request;
  }

  /**
   * Approves a request: stops the order where that is still legal, refunds what
   * can be refunded, and tells the customer which of those happened.
   *
   * The two halves are deliberately independent, exactly as the columns are: a
   * delivered order cannot be cancelled and is refunded without touching
   * fulfilment, and a cash order can be cancelled with no money to return.
   */
  async approve(actor: Actor, id: string, dto: ApproveRefundRequestDto) {
    if (!isStaff(actor)) {
      throw new ForbiddenException('Only staff may decide a refund request.');
    }

    const request = await this.loadPendingForStaff(actor, id);
    const order = request.order;

    const cancellable = canTransition(order.status, OrderStatus.CANCELLED, order.type);
    // Default: a cancellation request cancels, a refund request does not. Either
    // way a caller can say otherwise — a branch may want to refund a botched
    // order it has already sent out, or stop an order without refunding a
    // deposit — but it can never ask for a move the machine forbids.
    const shouldCancel = dto.cancelOrder ?? request.type === RefundRequestType.CANCELLATION;

    if (shouldCancel && !cancellable && dto.cancelOrder === true) {
      throw new BadRequestException(
        `An order in ${order.status} can no longer be cancelled. Approve the refund without cancelling.`,
      );
    }

    const willCancel = shouldCancel && cancellable;

    if (willCancel) {
      // Through the order engine's own choke point, so the state machine, the
      // status history, the delivery record and the loyalty reversal all behave
      // as they do for any other cancellation.
      await this.orders.cancelByStaff(actor, order.id, {
        reason: `Refund request approved: ${request.reason}`.slice(0, 500),
      });
    }

    const payment = await this.refundablePayment(order.id);
    const remaining = payment ? payment.capturedAmountMinor - payment.refundedAmountMinor : 0;
    const approvedAmountMinor = payment ? Math.min(dto.amountMinor ?? remaining, remaining) : null;

    if (dto.amountMinor !== undefined && payment && dto.amountMinor > remaining) {
      // The same ceiling `RefundsService` enforces, applied at the decision so a
      // branch cannot promise a customer more than the payment can give back.
      // Approving is where the number is said out loud; discovering it was
      // impossible at payout time means telling the customer twice.
      throw new BadRequestException(
        `The approved amount exceeds the ${remaining} still refundable on this order.`,
      );
    }

    // **Approving does not move money** (owner decision). The branch decides,
    // and the owner then issues the refund in the gateway's own dashboard and
    // records it here. So no gateway call and no `Refund` row is created — this
    // is a debt, and `refundIssuedAt` staying null is what says so.
    const outcome: ApprovalOutcome =
      payment && payment.gatewayPaymentId
        ? 'AWAITING_PAYOUT'
        : payment
          ? 'MANUAL_SETTLEMENT'
          : 'CANCELLED_NO_REFUND';

    const updated = await this.prisma.refundRequest.update({
      where: { id: request.id },
      data: {
        status: RefundRequestStatus.APPROVED,
        resolutionNote: dto.note ?? null,
        reviewedByUserId: actor.id,
        reviewedAt: new Date(),
        orderCancelled: willCancel,
        approvedAmountMinor,
      },
      select: staffRequestView,
    });

    await this.notifications.dispatch(
      order.id,
      NotificationType.REFUND_UPDATE,
      refundRequestApprovedMessage(
        { orderNumber: order.orderNumber, branchName: request.branch.name },
        { outcome, orderCancelled: willCancel, note: dto.note },
      ),
    );

    // A decision, not a payout — this row records that the branch agreed and
    // what it agreed to, which is distinct from money moving (that is
    // `refund.issued` below).
    await this.audit.record({
      action: AUDIT_ACTIONS.REFUND_REQUEST_APPROVE,
      entityType: AUDIT_ENTITIES.REFUND_REQUEST,
      entityId: request.id,
      branchId: request.branchId,
      after: { outcome, orderCancelled: willCancel, approvedAmountMinor },
    });

    return { request: updated, outcome };
  }

  /**
   * The owner recording a refund they have already paid out in the gateway's
   * own dashboard.
   *
   * This is the second half of an approval and a **separate act by a separate
   * person**: `refunds:write` gates it (owner-only) where the decision above is
   * gated by `refund-requests:decide` (the branch). Until this runs, the order
   * still reads as paid, the customer has not been told the money is on its
   * way, and the request sits in the payout queue — which is correct, because
   * none of those things have happened yet.
   *
   * It writes a real `Refund` row so the money appears in reports and in
   * settlement reconciliation, marked `issuedManually` because no webhook will
   * ever confirm it — nothing must sit waiting for one.
   */
  async recordRefundIssued(actor: Actor, id: string, dto: RecordRefundIssuedDto) {
    if (!isStaff(actor)) {
      throw new ForbiddenException('Only staff may record a refund.');
    }

    const request = await this.prisma.refundRequest.findFirst({
      where: { id },
      select: {
        id: true,
        branchId: true,
        status: true,
        orderId: true,
        refundId: true,
        approvedAmountMinor: true,
        reason: true,
        order: { select: { id: true, orderNumber: true } },
        branch: { select: { name: true } },
      },
    });

    if (!request) {
      throw new NotFoundException('Request not found.');
    }

    assertBranchAccess(actor, request.branchId);

    if (request.status !== RefundRequestStatus.APPROVED) {
      throw new ConflictException(
        'Only an approved request can have a refund recorded against it.',
      );
    }

    if (request.refundId) {
      throw new ConflictException('A refund has already been recorded for this request.');
    }

    const payment = await this.refundablePayment(request.orderId);

    if (!payment) {
      throw new BadRequestException(
        'This order has no payment with money left on it. A cash refund is settled at the branch, not recorded here.',
      );
    }

    const remaining = payment.capturedAmountMinor - payment.refundedAmountMinor;
    const amountMinor = dto.amountMinor ?? request.approvedAmountMinor ?? remaining;

    if (amountMinor <= 0 || amountMinor > remaining) {
      throw new BadRequestException(
        `The amount must be between 1 and the ${remaining} still refundable on this order.`,
      );
    }

    const fullyRefunded = payment.refundedAmountMinor + amountMinor >= payment.capturedAmountMinor;
    const moneyStatus = fullyRefunded ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED;

    // One transaction: the refund record, the money on the payment, the order's
    // money column and the request's own link. Recording that money left is not
    // a thing that may half-happen.
    await this.prisma
      .$transaction(async (tx) => {
        const created = await tx.refund.create({
          data: {
            paymentId: payment.id,
            orderId: request.orderId,
            amountMinor,
            // Already done, in the dashboard, before anyone pressed this. There
            // is no PROCESSING state to pass through and nothing to wait for.
            status: RefundStatus.COMPLETED,
            completedAt: new Date(),
            reason: dto.note ?? `Refund request ${request.id}`,
            requestedByUserId: actor.id,
            gatewayReference: dto.gatewayReference,
            issuedManually: true,
            // Derived from the request, like the approval was: recording the
            // same payout twice cannot create two refunds, however many times
            // the button is pressed on a slow connection.
            idempotencyKey: `refund-request-manual:${request.id}`,
          },
          select: { id: true, amountMinor: true },
        });

        await tx.payment.update({
          where: { id: payment.id },
          data: {
            refundedAmountMinor: payment.refundedAmountMinor + amountMinor,
            status: moneyStatus,
          },
        });

        await tx.order.update({
          where: { id: request.orderId },
          data: { paymentStatus: moneyStatus },
        });

        await tx.refundRequest.update({
          where: { id: request.id },
          data: { refundId: created.id, refundIssuedAt: new Date() },
        });

        return created;
      })
      .catch((error: unknown) => {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new ConflictException('A refund has already been recorded for this request.');
        }
        throw error;
      });

    // Post-commit and best-effort, exactly like the gateway-driven path in
    // `PaymentsService.handleWebhook`: the customer is told, and loyalty points
    // are reversed in proportion to what was refunded.
    await this.notifications.dispatch(
      request.orderId,
      NotificationType.REFUND_UPDATE,
      refundIssuedMessage(
        { orderNumber: request.order.orderNumber, branchName: request.branch.name },
        amountMinor,
      ),
    );
    await this.loyalty.reverseForRefund(request.orderId);
    // Issue a ZATCA credit note against the order's tax invoice. Best-effort and
    // idempotent — no-op unless invoicing is enabled and an invoice exists.
    await this.zatca.issueCreditNoteForRefund(request.orderId, request.reason ?? 'Refund issued');

    // Money actually left here. Distinct from the approval above, and often
    // hours later — the gateway reference ties this row to its payout line.
    await this.audit.record({
      action: AUDIT_ACTIONS.REFUND_ISSUED,
      entityType: AUDIT_ENTITIES.REFUND_REQUEST,
      entityId: request.id,
      branchId: request.branchId,
      after: { amountMinor, gatewayReference: dto.gatewayReference, issuedManually: true },
    });

    return this.prisma.refundRequest.findUniqueOrThrow({
      where: { id: request.id },
      select: staffRequestView,
    });
  }

  async reject(actor: Actor, id: string, dto: RejectRefundRequestDto) {
    if (!isStaff(actor)) {
      throw new ForbiddenException('Only staff may decide a refund request.');
    }

    const request = await this.loadPendingForStaff(actor, id);

    const updated = await this.prisma.refundRequest.update({
      where: { id: request.id },
      data: {
        status: RefundRequestStatus.REJECTED,
        resolutionNote: dto.note,
        reviewedByUserId: actor.id,
        reviewedAt: new Date(),
      },
      select: staffRequestView,
    });

    await this.notifications.dispatch(
      request.order.id,
      NotificationType.REFUND_UPDATE,
      refundRequestRejectedMessage(
        { orderNumber: request.order.orderNumber, branchName: request.branch.name },
        dto.note,
      ),
    );

    await this.audit.record({
      action: AUDIT_ACTIONS.REFUND_REQUEST_REJECT,
      entityType: AUDIT_ENTITIES.REFUND_REQUEST,
      entityId: request.id,
      branchId: request.branchId,
      reason: dto.note,
    });

    return updated;
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  /**
   * Runs the pure rule against an order the customer owns.
   *
   * One place, called by both the eligibility read and the create — the check
   * that decides whether a button appears and the check that enforces it must
   * be the same code, or the app offers something the server refuses.
   */
  private eligibilityOf(order: {
    status: OrderStatus;
    paymentStatus: PaymentStatus;
    placedAt: Date;
    deliveredAt: Date | null;
    cancelledAt: Date | null;
    refundRequests: { id: string }[];
  }): RefundRequestEligibility {
    return refundRequestEligibility(
      {
        status: order.status,
        paymentStatus: order.paymentStatus,
        placedAt: order.placedAt,
        deliveredAt: order.deliveredAt,
        cancelledAt: order.cancelledAt,
        hasOpenRequest: order.refundRequests.length > 0,
      },
      new Date(),
      {
        cancellationMinutes: this.config.refunds.cancellationWindowMinutes,
        refundMinutes: this.config.refunds.requestWindowMinutes,
      },
    );
  }

  private async loadOwnOrder(actor: Actor, orderId: string) {
    if (!isCustomer(actor)) {
      throw new ForbiddenException('Only customers may raise a refund request.');
    }

    const order = await this.prisma.order.findFirst({
      where: { id: orderId, customerId: actor.id, deletedAt: null },
      select: {
        id: true,
        orderNumber: true,
        customerId: true,
        branchId: true,
        status: true,
        paymentStatus: true,
        placedAt: true,
        deliveredAt: true,
        cancelledAt: true,
        branch: { select: { name: true } },
        refundRequests: {
          where: { status: RefundRequestStatus.PENDING },
          select: { id: true },
          take: 1,
        },
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found.');
    }

    return order;
  }

  private async loadPendingForStaff(actor: Actor, id: string) {
    const request = await this.prisma.refundRequest.findFirst({
      where: { id },
      select: {
        id: true,
        branchId: true,
        status: true,
        type: true,
        reason: true,
        branch: { select: { name: true } },
        order: {
          select: {
            id: true,
            orderNumber: true,
            status: true,
            type: true,
            paymentStatus: true,
          },
        },
      },
    });

    if (!request) {
      throw new NotFoundException('Request not found.');
    }

    assertBranchAccess(actor, request.branchId);

    if (request.status !== RefundRequestStatus.PENDING) {
      throw new ConflictException('This request has already been decided.');
    }

    return request;
  }

  /**
   * The order's payment that still has money on it, if any.
   *
   * `gatewayPaymentId` is what separates "refund it online" from "the branch
   * hands the cash back": a counter-cash or cash-on-delivery payment has none,
   * and `RefundsService` refuses it outright — correctly, since there is no
   * gateway to reverse. The caller reports that as a manual settlement rather
   * than letting the refusal read as a failure.
   */
  private async refundablePayment(orderId: string) {
    const payment = await this.prisma.payment.findFirst({
      where: {
        orderId,
        status: { in: [PaymentStatus.PAID, PaymentStatus.PARTIALLY_REFUNDED] },
      },
      select: {
        id: true,
        gatewayPaymentId: true,
        capturedAmountMinor: true,
        refundedAmountMinor: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!payment) {
      return null;
    }

    // A payment whose captured amount has already gone back in full is not money
    // to return, and handing it to `createRefund` would only produce a refusal
    // that reads to staff as a failed approval.
    const remaining = payment.capturedAmountMinor - payment.refundedAmountMinor;

    return remaining > 0 ? payment : null;
  }
}
