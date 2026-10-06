import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DeliveryStatus, OrderStatus, PaymentMethod, Prisma } from '@prisma/client';

import { Actor, isStaff } from '../auth/types/actor';
import { assertBranchAccess, resolveRequestedBranches } from '../branches/branch-scope';
import { buildPaginationMeta } from '../common/dto/pagination.dto';
import { toCoordinate } from '../common/geo';
import { DriversService } from '../drivers/drivers.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrdersService } from '../orders/orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { canCallCustomer } from './customer-contact';
import { canTransitionDelivery, deliveryTimestampFieldFor } from './delivery-status.machine';
import {
  AssignDriverDto,
  DeliveryProgressDto,
  ListDeliveriesQueryDto,
  MarkDeliveredDto,
  MarkDeliveryFailedDto,
  MyDeliveriesQueryDto,
} from './dto/delivery.dto';

/** The order fulfilment status each driver-initiated delivery status corresponds to. */
const ORDER_STATUS_FOR: Partial<Record<DeliveryStatus, OrderStatus>> = {
  [DeliveryStatus.PICKED_UP]: OrderStatus.PICKED_UP,
  [DeliveryStatus.OUT_FOR_DELIVERY]: OrderStatus.OUT_FOR_DELIVERY,
  [DeliveryStatus.DELIVERED]: OrderStatus.DELIVERED,
};

/** The response shape for every delivery read — staff and driver alike. */
const deliveryView = {
  id: true,
  orderId: true,
  branchId: true,
  driverId: true,
  status: true,
  addressSnapshot: true,
  distanceKm: true,
  assignedAt: true,
  pickedUpAt: true,
  deliveredAt: true,
  cancelledAt: true,
  failedAt: true,
  failureReason: true,
  proofType: true,
  proofUrl: true,
  recipientName: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  order: { select: { orderNumber: true, referenceId: true, branchId: true, status: true } },
  // The assigned driver's live location, for the tracking map. No phone number —
  // privacy-safe contact is unchanged (see the class note).
  driver: {
    select: {
      id: true,
      vehicleType: true,
      currentLatitude: true,
      currentLongitude: true,
      lastLocationAt: true,
      user: { select: { fullName: true } },
    },
  },
} satisfies Prisma.DeliverySelect;

/**
 * The driver-facing read shape: everything in `deliveryView`, plus just enough
 * of the order's money to run the cash-on-delivery step.
 *
 * A driver may see whether their own delivery is cash-on-delivery and how much
 * cash to collect, but never a card payment's gateway detail — so only the COD
 * payment is selected, and only its safe amount/status fields. The order total
 * and currency come along so the app can show the amount due without ever
 * computing it (spec rule: apps display totals, never derive them).
 */
const driverDeliveryView = {
  ...deliveryView,
  order: {
    select: {
      orderNumber: true,
      referenceId: true,
      branchId: true,
      status: true,
      type: true,
      currency: true,
      totalMinor: true,
      // Selected here, but **not** returned unconditionally: `toDriverDelivery`
      // strips it unless `canCallCustomer` allows it for this delivery's
      // status. The row is loaded for the driver who owns the delivery, so the
      // gate is about *when*, not *who* — see `customer-contact.ts`.
      customer: { select: { fullName: true, phone: true } },
      payments: {
        where: { method: PaymentMethod.CASH_ON_DELIVERY },
        select: { amountMinor: true, capturedAmountMinor: true, status: true },
      },
    },
  },
  cashCollection: {
    select: {
      id: true,
      expectedMinor: true,
      collectedMinor: true,
      varianceMinor: true,
      note: true,
      createdAt: true,
    },
  },
} satisfies Prisma.DeliverySelect;

type DriverDeliveryRow = Prisma.DeliveryGetPayload<{ select: typeof driverDeliveryView }>;

/**
 * Delivery (Phase 14).
 *
 * Owns assignment and the driver-facing leg of fulfilment. `Delivery` rows
 * themselves are opened and cancelled by `OrdersService` at its single
 * transition choke point (READY opens one for a delivery order; CANCELLED
 * closes it) — this service drives everything from `ASSIGNED` onward, and
 * every driver-initiated move here also advances the matching `Order.status`
 * through `OrdersService.applyTransition`, in the same transaction, so the two
 * records can never disagree about how far a delivery has got.
 *
 * **The assigned driver can call the customer from pickup onward — unmasked.**
 * This reverses the platform's original rule, and the reversal is an owner
 * decision rather than a drift: no call-masking provider is contracted, the
 * safe default had been to withhold the number entirely, and the cost of that
 * default was a driver at an unmarked gate with a cooling bag and nobody to
 * ring. The owner has accepted the trade.
 *
 * It is kept as narrow as that decision allows, server-side: only the driver
 * the delivery is actually assigned to (`loadOwn`), only from `PICKED_UP`
 * onward (`customer-contact.ts`), and **stripped from the payload** rather than
 * hidden by the app when the gate is closed — a field a screen chooses not to
 * render is still a field anyone can read out of the response. Nothing else
 * changed: the staff view is untouched, and no other driver-facing surface
 * carries it.
 *
 * **A post-pickup failure never touches `Order.status`.** The order machine
 * (Phase 8) allows `CANCELLED` only up to `DRIVER_ASSIGNED` — once picked up,
 * cancelling the order is not a legal move (food has left the branch). So a
 * delivery that fails after pickup is recorded as `Delivery.FAILED` with a
 * reason, and the order is left exactly where it was for staff to resolve
 * manually; this is a genuine gap in the fulfilment model, not an oversight,
 * and it is flagged rather than papered over with an illegal or invented
 * transition.
 */
@Injectable()
export class DeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly drivers: DriversService,
    private readonly notifications: NotificationsService,
    private readonly loyalty: LoyaltyService,
    private readonly realtime: RealtimeService,
  ) {}

  // ===========================================================================
  // Staff
  // ===========================================================================

  async listForStaff(actor: Actor, query: ListDeliveriesQueryDto) {
    const where: Prisma.DeliveryWhereInput = {
      ...resolveRequestedBranches(actor, query.branchId),
      ...(query.status ? { status: query.status } : {}),
      ...(query.driverId ? { driverId: query.driverId } : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.delivery.findMany({
        where,
        select: deliveryView,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.delivery.count({ where }),
    ]);

    return {
      data: data.map((row) => serializeDelivery(row)),
      meta: buildPaginationMeta(total, query),
    };
  }

  async getForStaff(actor: Actor, id: string) {
    const delivery = await this.loadDelivery(id);
    assertBranchAccess(actor, delivery.branchId);
    return delivery;
  }

  /**
   * Live delivery tracking for the customer who owns the order.
   *
   * Ownership is by the order's customer id — a customer sees only their own
   * order's delivery, including the driver's current map location. It never
   * exposes the driver's phone number (privacy-safe contact, unchanged).
   */
  async getTrackingForCustomer(customerId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, customerId, deletedAt: null },
      select: { id: true },
    });
    if (!order) {
      throw new NotFoundException('Order not found.');
    }
    const delivery = await this.prisma.delivery.findUnique({
      where: { orderId },
      select: deliveryView,
    });
    if (!delivery) {
      throw new NotFoundException('This order has no delivery yet.');
    }
    return serializeDelivery(delivery);
  }

  /**
   * Assigns a driver to a delivery still awaiting one. Moves both the delivery
   * (`PENDING_ASSIGNMENT` → `ASSIGNED`) and its order (`READY` →
   * `DRIVER_ASSIGNED`) together, and holds the driver's availability down for
   * the duration of the job.
   */
  async assignDriver(actor: Actor, deliveryId: string, dto: AssignDriverDto) {
    const delivery = await this.loadDelivery(deliveryId);
    assertBranchAccess(actor, delivery.branchId);

    if (!canTransitionDelivery(delivery.status, DeliveryStatus.ASSIGNED)) {
      throw new ConflictException('This delivery cannot be assigned right now.');
    }

    const driver = await this.prisma.driver.findFirst({
      where: { id: dto.driverId, deletedAt: null },
    });
    if (!driver) {
      throw new NotFoundException('Driver not found.');
    }
    // Only "on shift" is required. **Being busy is no longer a refusal**: a
    // counter must be able to hand a second drop to the driver already heading
    // that way, which is how a small fleet actually runs and was impossible
    // while `isAvailable` gated assignment — the food sat on the pass until
    // somebody came back. The ceiling on stacking is
    // `DriversService.assertCanTakeAnotherJob`, applied inside the transaction.
    //
    // Checked here only to give a clear message for the ordinary case; the
    // check that holds is the conditional update below, since this read can be
    // stale by the time we write.
    if (!driver.isOnline) {
      throw new BadRequestException('This driver is off shift.');
    }

    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: delivery.orderId },
      select: { id: true, status: true, type: true },
    });

    const stacked = await this.prisma.$transaction(async (tx) => {
      // Claim the driver and the delivery conditionally, so two dispatchers
      // acting at once cannot both succeed.
      //
      // Reading state outside the transaction and writing unconditionally let
      // one delivery be assigned to four drivers at once — every caller read
      // the same row, every caller passed, every caller wrote. The database has
      // to be what serialises this, not the order the reads happened to land
      // in. That still holds; what changed is *what* is being serialised. The
      // claim used to be `isAvailable: true → false`, which doubled as the
      // "is this driver free" test. A busy driver may now take another job, so
      // the count is the test and it is taken inside the same transaction.
      const alreadyHeld = await this.drivers.assertCanTakeAnotherJob(tx, driver.id);

      const claimedDriver = await tx.driver.updateMany({
        where: { id: driver.id, deletedAt: null, isOnline: true },
        data: { isAvailable: false },
      });

      if (claimedDriver.count === 0) {
        throw new BadRequestException('This driver is no longer on shift.');
      }

      const claimedDelivery = await tx.delivery.updateMany({
        where: { id: delivery.id, status: delivery.status, driverId: null },
        data: { driverId: driver.id, status: DeliveryStatus.ASSIGNED, assignedAt: new Date() },
      });

      if (claimedDelivery.count === 0) {
        throw new ConflictException('This delivery has already been assigned.');
      }

      await tx.deliveryStatusHistory.create({
        data: {
          deliveryId: delivery.id,
          fromStatus: delivery.status,
          toStatus: DeliveryStatus.ASSIGNED,
          changedByUserId: this.staffId(actor),
        },
      });
      await this.orders.applyTransition(tx, order, OrderStatus.DRIVER_ASSIGNED, actor, {});

      return alreadyHeld + 1;
    });

    await this.notifications.onOrderStatus(order.id, OrderStatus.DRIVER_ASSIGNED);
    // Takes this driver out of the "free" column on every board that is open,
    // and tells the counter how loaded they now are.
    this.realtime.driverStatus({
      driverId: driver.id,
      branchId: driver.branchId,
      isOnline: driver.isOnline,
      isAvailable: false,
      activeDeliveryCount: stacked,
    });
    this.realtime.deliveryAssigned({
      deliveryId: delivery.id,
      orderId: delivery.orderId,
      branchId: delivery.branchId,
      driverId: driver.id,
      // Carries the driver's own channel, so the job lands on their phone the
      // moment it is assigned rather than on the next poll.
      driverUserId: driver.userId,
      status: DeliveryStatus.ASSIGNED,
    });

    return this.loadDelivery(delivery.id);
  }

  /**
   * Takes a delivery back off its driver and returns it to the pool.
   *
   * A driver can stop being able to do a job after accepting it — shift ends,
   * phone dies, the wrong driver was picked, the account is deactivated. There
   * was no way to move a delivery to anyone else: the machine had no
   * `ASSIGNED → ASSIGNED` edge and no unassign path, so the only escape was
   * cancelling the customer's order. A driver deactivated mid-job stranded
   * every delivery they held, permanently.
   *
   * Only before pickup. Once the food is in the car, where it goes is a
   * physical problem and reassigning the record would just lie about it —
   * `markFailed` is the honest path there.
   *
   * The driver is freed in the same transaction, and the order returns to
   * READY, which is exactly where it sat before assignment.
   */
  async unassignDriver(actor: Actor, deliveryId: string, reason?: string) {
    const delivery = await this.loadDelivery(deliveryId);
    assertBranchAccess(actor, delivery.branchId);

    if (!canTransitionDelivery(delivery.status, DeliveryStatus.PENDING_ASSIGNMENT)) {
      throw new ConflictException(
        'Only a delivery that has not been picked up can be taken off its driver.',
      );
    }

    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: delivery.orderId },
      select: { id: true, status: true, type: true },
    });

    // Read before the transaction clears `driverId`: the driver about to lose
    // this job is exactly who has to be told, and after the write there is no
    // longer a link back to them.
    const releasedDriver = delivery.driverId
      ? await this.prisma.driver.findUnique({
          where: { id: delivery.driverId },
          select: { id: true, userId: true },
        })
      : null;

    await this.prisma.$transaction(async (tx) => {
      // Conditional, for the same reason assignment is: two people freeing the
      // same delivery must not both succeed and free two drivers.
      const released = await tx.delivery.updateMany({
        where: { id: delivery.id, status: DeliveryStatus.ASSIGNED },
        data: { driverId: null, status: DeliveryStatus.PENDING_ASSIGNMENT, assignedAt: null },
      });

      if (released.count === 0) {
        throw new ConflictException('This delivery has already moved on.');
      }

      await tx.deliveryStatusHistory.create({
        data: {
          deliveryId: delivery.id,
          fromStatus: delivery.status,
          toStatus: DeliveryStatus.PENDING_ASSIGNMENT,
          changedByUserId: this.staffId(actor),
          note: reason,
        },
      });

      if (delivery.driverId) {
        // Free again only if this was their last job and they are still on
        // shift. `releaseAfterDelivery` owns both halves of that rule now, so a
        // driver still carrying two more drops is not put back into the free
        // pool the moment one is taken off them.
        await this.drivers.releaseAfterDelivery(tx, delivery.driverId);
      }

      await this.orders.applyTransition(tx, order, OrderStatus.READY, actor, {});
    });

    // Post-commit and best-effort, like every other emit here. The branch board
    // gets the delivery back in its unassigned column, and the driver's app
    // drops a job that is no longer theirs instead of showing it until the next
    // poll — long enough for two people to set off for the same pickup.
    this.realtime.deliveryUnassigned({
      deliveryId: delivery.id,
      orderId: delivery.orderId,
      branchId: delivery.branchId,
      driverId: releasedDriver?.id ?? null,
      driverUserId: releasedDriver?.userId ?? null,
      status: DeliveryStatus.PENDING_ASSIGNMENT,
    });
    await this.announceDriver(releasedDriver?.id ?? null);

    return this.loadDelivery(delivery.id);
  }

  // ===========================================================================
  // Driver self-service
  // ===========================================================================

  async myDeliveries(actor: Actor, query: MyDeliveriesQueryDto) {
    const driver = await this.drivers.getOwnDriverRecord(actor);
    const where: Prisma.DeliveryWhereInput = {
      driverId: driver.id,
      ...(query.status ? { status: query.status } : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.delivery.findMany({
        where,
        select: driverDeliveryView,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.delivery.count({ where }),
    ]);

    return {
      data: data.map((row) => this.toDriverDelivery(row)),
      meta: buildPaginationMeta(total, query),
    };
  }

  async getOwnDelivery(actor: Actor, id: string) {
    const { delivery } = await this.loadOwn(actor, id);
    return this.loadDriverDelivery(delivery.id);
  }

  markPickedUp(actor: Actor, id: string, dto: DeliveryProgressDto) {
    return this.driverTransition(actor, id, DeliveryStatus.PICKED_UP, dto);
  }

  markOutForDelivery(actor: Actor, id: string, dto: DeliveryProgressDto) {
    return this.driverTransition(actor, id, DeliveryStatus.OUT_FOR_DELIVERY, dto);
  }

  async markDelivered(actor: Actor, id: string, dto: MarkDeliveredDto) {
    const { driver, delivery, order } = await this.loadOwn(actor, id);

    if (!canTransitionDelivery(delivery.status, DeliveryStatus.DELIVERED)) {
      throw new ConflictException('This delivery cannot be marked delivered right now.');
    }

    // Enforced here too, not only by the DTO's @ValidateIf — a caller inside
    // the backend (this method is also reachable outside HTTP) must not be
    // able to record signature/photo proof with no actual capture behind it.
    const needsProofUrl = dto.proofType === 'SIGNATURE' || dto.proofType === 'PHOTO';
    if (needsProofUrl && !dto.proofUrl) {
      throw new BadRequestException('proofUrl is required for signature or photo proof.');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.delivery.update({
        where: { id: delivery.id },
        data: {
          status: DeliveryStatus.DELIVERED,
          deliveredAt: new Date(),
          proofType: dto.proofType,
          proofUrl: dto.proofUrl ?? null,
          recipientName: dto.recipientName ?? null,
          notes: dto.notes ?? null,
        },
      });
      await tx.deliveryStatusHistory.create({
        data: {
          deliveryId: delivery.id,
          fromStatus: delivery.status,
          toStatus: DeliveryStatus.DELIVERED,
          changedByUserId: driver.userId,
          latitude: dto.latitude,
          longitude: dto.longitude,
        },
      });
      await this.drivers.releaseAfterDelivery(tx, driver.id);
      await this.orders.applyTransition(tx, order, OrderStatus.DELIVERED, actor, {});
    });

    await this.notifications.onOrderStatus(order.id, OrderStatus.DELIVERED);
    await this.loyalty.earnForOrder(order.id);
    // Puts them back in the counter's picker the moment their last drop is
    // signed for — and, when they are still carrying others, updates the load
    // the picker shows rather than claiming they are free.
    await this.announceDriver(driver.id);

    return this.loadDriverDelivery(delivery.id);
  }

  /**
   * Records a delivery that could not be completed after pickup. Does **not**
   * move the order — see the class note on why that transition is illegal
   * post-pickup. Staff must resolve the order manually (e.g. a re-attempt or a
   * refund) once this is recorded.
   */
  async markFailed(actor: Actor, id: string, dto: MarkDeliveryFailedDto) {
    const { driver, delivery } = await this.loadOwn(actor, id);

    if (!canTransitionDelivery(delivery.status, DeliveryStatus.FAILED)) {
      throw new ConflictException(
        'This delivery cannot be marked failed right now. Before pickup, cancel the order instead.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.delivery.update({
        where: { id: delivery.id },
        data: { status: DeliveryStatus.FAILED, failedAt: new Date(), failureReason: dto.reason },
      });
      await tx.deliveryStatusHistory.create({
        data: {
          deliveryId: delivery.id,
          fromStatus: delivery.status,
          toStatus: DeliveryStatus.FAILED,
          changedByUserId: driver.userId,
          latitude: dto.latitude,
          longitude: dto.longitude,
          note: dto.reason,
        },
      });
      await this.drivers.releaseAfterDelivery(tx, driver.id);
    });

    await this.announceDriver(driver.id);

    return this.loadDriverDelivery(delivery.id);
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  private async driverTransition(
    actor: Actor,
    id: string,
    toStatus: DeliveryStatus,
    dto: DeliveryProgressDto,
  ) {
    const { driver, delivery, order } = await this.loadOwn(actor, id);

    if (!canTransitionDelivery(delivery.status, toStatus)) {
      throw new ConflictException(`This delivery cannot move to ${toStatus} right now.`);
    }

    const orderStatus = ORDER_STATUS_FOR[toStatus];
    if (!orderStatus) {
      // Unreachable for the statuses this method is called with — kept as a
      // guard so a future caller cannot silently skip the order-side move.
      throw new ConflictException(`No matching order status for ${toStatus}.`);
    }

    const timestampField = deliveryTimestampFieldFor(toStatus);

    await this.prisma.$transaction(async (tx) => {
      await tx.delivery.update({
        where: { id: delivery.id },
        data: { status: toStatus, ...(timestampField ? { [timestampField]: new Date() } : {}) },
      });
      await tx.deliveryStatusHistory.create({
        data: {
          deliveryId: delivery.id,
          fromStatus: delivery.status,
          toStatus,
          changedByUserId: driver.userId,
          latitude: dto.latitude,
          longitude: dto.longitude,
          note: dto.notes,
        },
      });
      await this.orders.applyTransition(tx, order, orderStatus, actor, {});
    });

    await this.notifications.onOrderStatus(order.id, orderStatus);

    return this.loadDriverDelivery(delivery.id);
  }

  private async loadOwn(actor: Actor, id: string) {
    const driver = await this.drivers.getOwnDriverRecord(actor);
    const delivery = await this.loadDelivery(id);

    // Not-found rather than forbidden — a driver must not be able to tell the
    // difference between "no such delivery" and "someone else's delivery" by
    // probing ids.
    if (delivery.driverId !== driver.id) {
      throw new NotFoundException('Delivery not found.');
    }

    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: delivery.orderId },
      select: { id: true, status: true, type: true },
    });

    return { driver, delivery, order };
  }

  private async loadDelivery(id: string) {
    const delivery = await this.prisma.delivery.findFirst({ where: { id }, select: deliveryView });
    if (!delivery) {
      throw new NotFoundException('Delivery not found.');
    }
    return serializeDelivery(delivery);
  }

  /** Loads a delivery in the driver-facing shape (with COD amount + any cash record). */
  private async loadDriverDelivery(id: string) {
    const row = await this.prisma.delivery.findFirst({ where: { id }, select: driverDeliveryView });
    if (!row) {
      throw new NotFoundException('Delivery not found.');
    }
    return this.toDriverDelivery(row);
  }

  /**
   * Shapes a driver delivery row for the app: surfaces the cash-on-delivery flag
   * and the amount to collect, and drops the raw `payments` array so no
   * card-payment detail leaks to the driver. `amountDueMinor` mirrors the
   * expected figure the reconciliation service computes server-side — the app
   * only displays it, never derives it.
   */
  private toDriverDelivery(row: DriverDeliveryRow) {
    const { payments, customer, ...order } = row.order;
    const cod = payments[0] ?? null;
    const amountDueMinor = cod ? cod.capturedAmountMinor || cod.amountMinor : null;

    // The customer's number, and only from pickup onward. **Stripped from the
    // payload rather than hidden by the app**: a field an app chooses not to
    // render is still a field anyone can read out of the response, and this is
    // a real, unmasked personal phone number.
    //
    // Owner decision (see `customer-contact.ts`): a driver at an unmarked gate
    // with a cooling bag and no way to reach anybody is the failure this
    // answers. It replaces a platform rule that withheld the number entirely.
    const contactable = canCallCustomer(row.status);

    return {
      ...serializeDelivery(row),
      order,
      isCashOnDelivery: cod !== null,
      amountDueMinor,
      /**
       * Who to ask for at the door.
       *
       * `Delivery.recipientName` is captured *at* drop-off, so before that the
       * customer's own name is the only one there is — and "ask for Fatimah" is
       * how a driver gets through a reception desk.
       */
      customerName: contactable ? (customer?.fullName ?? null) : null,
      /** E.164, unmasked, or null while the gate is closed. */
      customerPhone: contactable ? (customer?.phone ?? null) : null,
    };
  }

  /**
   * Re-reads a driver's shift state and pushes it to the boards.
   *
   * Post-commit and best-effort, like every other emit here — a realtime push
   * must never be able to fail a delivery that has already happened. It re-reads
   * rather than reasoning from the row it had, because whether the driver came
   * free depends on how many *other* jobs they still hold, which only the
   * database knows once the transaction has landed.
   */
  private async announceDriver(driverId: string | null): Promise<void> {
    if (!driverId) {
      return;
    }
    try {
      const driver = await this.prisma.driver.findUnique({
        where: { id: driverId },
        select: { id: true, branchId: true, isOnline: true, isAvailable: true },
      });
      if (!driver) {
        return;
      }
      this.realtime.driverStatus({
        driverId: driver.id,
        branchId: driver.branchId,
        isOnline: driver.isOnline,
        isAvailable: driver.isAvailable,
        activeDeliveryCount: await this.drivers.activeDeliveryCount(driver.id),
      });
    } catch {
      // Swallowed on purpose: the delivery is done either way, and the boards
      // poll as their floor.
    }
  }

  private staffId(actor: Actor): string | null {
    return isStaff(actor) ? actor.id : null;
  }
}

/**
 * Converts the `Decimal` columns on a delivery row into numbers.
 *
 * Every read in this service goes through here, because a `Decimal` that
 * reaches a client un-converted arrives as a JSON **string** — see
 * `src/common/geo.ts` for what that cost on two different maps. The driver's
 * position is the one that matters most: it is the only coordinate on this
 * payload the apps plot.
 */
function serializeDelivery<
  T extends {
    distanceKm?: unknown;
    driver?: { currentLatitude: unknown; currentLongitude: unknown } | null;
  },
>(row: T): T {
  return {
    ...row,
    ...(row.distanceKm !== undefined ? { distanceKm: toCoordinate(row.distanceKm as never) } : {}),
    ...(row.driver
      ? {
          driver: {
            ...row.driver,
            currentLatitude: toCoordinate(row.driver.currentLatitude as never),
            currentLongitude: toCoordinate(row.driver.currentLongitude as never),
          },
        }
      : {}),
  };
}
