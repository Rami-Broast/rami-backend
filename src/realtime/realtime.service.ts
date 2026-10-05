import { Injectable, Logger } from '@nestjs/common';
import type { Server } from 'socket.io';

/** Room names. Kept in one place so producer and consumer never drift. */
export const ROOMS = {
  /** Every OWNER (branchScope ALL) lands here — they see all branches. */
  staffAll: 'staff:all',
  branch: (branchId: string) => `branch:${branchId}`,
  customer: (customerId: string) => `customer:${customerId}`,
  /**
   * One driver's own channel, keyed by their **user** id rather than their
   * `Driver.id`.
   *
   * The gateway only ever holds an `Actor`, which carries the user id, so
   * keying the room this way lets a driver's socket join on the handshake with
   * no extra query. Producers hold the `Driver` row (and therefore its
   * `userId`) at every point they need to emit, so nothing is lost.
   */
  driver: (userId: string) => `driver:${userId}`,
} as const;

/**
 * The event names clients subscribe to. One source of truth for producer and
 * every consumer (admin app, customer app).
 */
export const REALTIME_EVENTS = {
  orderAwaiting: 'order.awaiting',
  orderTransitioned: 'order.transitioned',
  deliveryAssigned: 'delivery.assigned',
  /**
   * A delivery was taken back off its driver. The driver app needs this as much
   * as it needs the assignment: without it, a job that is no longer theirs
   * stays on their screen until the next poll, and a driver can set off for a
   * pickup somebody else is already doing.
   */
  deliveryUnassigned: 'delivery.unassigned',
  driverLocation: 'driver.location',
  /**
   * A driver's shift state changed — they went on or off shift, stepped away,
   * were put on a job, or finished one.
   *
   * It exists because the counter's driver picker is a snapshot: a branch would
   * open it, read "no available drivers", and have no way to learn that someone
   * had started their shift ten seconds later short of closing the dialog and
   * opening it again. During service, with the food on the pass, that is the
   * difference between dispatching now and dispatching when somebody happens to
   * look.
   */
  driverStatus: 'driver.status',
} as const;

export interface OrderEventPayload {
  orderId: string;
  orderNumber: string;
  /** Globally unique 12-digit public reference — see `src/orders/order-number.ts`. */
  referenceId?: string;
  branchId: string;
  status: string;
  /** Present so the customer app can match an event to the order on screen. */
  customerId?: string;
}

export interface DeliveryEventPayload {
  deliveryId: string;
  orderId: string;
  branchId: string;
  driverId: string | null;
  status: string;
  /**
   * The assigned (or just-released) driver's **user** id, so the event can be
   * delivered to that one driver's room as well as to the branch.
   *
   * Optional because the payload is also the branch-facing shape, and a caller
   * that has no driver in hand must still be able to emit. It is routing only
   * and is stripped before the event goes out — see `deliveryAssigned`.
   */
  driverUserId?: string | null;
}

export interface DriverStatusPayload {
  driverId: string;
  /**
   * The branch the driver belongs to, or null for one nobody has assigned.
   *
   * A null-branch driver reaches owners only — which is exactly who can see
   * them at all, since `DriversService.listForStaff` is branch-scoped and an
   * unassigned driver deliberately matches no branch filter.
   */
  branchId: string | null;
  isOnline: boolean;
  isAvailable: boolean;
  /** How many deliveries they are carrying — "on a job" and "on three" differ. */
  activeDeliveryCount: number;
}

export interface DriverLocationPayload {
  driverId: string;
  branchId: string;
  latitude: number;
  longitude: number;
  at: string;
  /**
   * The customer waiting on this delivery, when the delivery is live enough for
   * them to be told. **Routing only — stripped before the staff emit**, exactly
   * like `driverUserId` on an assignment: the branch-facing copy is read by
   * every owner's browser and has no business carrying a customer id.
   *
   * Absent means nobody is watching this ping but staff — the delivery is not
   * live, or the driver is between jobs.
   */
  customerId?: string | null;
  /** The order the customer is tracking, so their app can ignore other pings. */
  orderId?: string | null;
}

/**
 * What the *customer* is told about their driver's position.
 *
 * Deliberately smaller than the staff payload: a position, a time, and the
 * order it belongs to. No `driverId`, no `branchId` — a customer tracking their
 * dinner has no use for either, and the smallest payload that answers "where is
 * my food" is the one that ages best.
 */
export interface CustomerDriverLocationPayload {
  orderId: string;
  latitude: number;
  longitude: number;
  at: string;
}

/**
 * Domain-facing facade over the realtime transport.
 *
 * Deliberately has **no injected dependencies**: it holds an optional
 * socket.io `Server` that the gateway hands it once the transport is up
 * (`register`). That keeps this provider lightweight enough for any feature
 * module — and any integration test composing one — to depend on it without
 * dragging in the gateway's auth machinery or a live socket server. When no
 * server is registered (a unit/integration test that never starts the
 * transport), every emit is a silent no-op.
 *
 * Every method is fire-and-forget and swallows its own failure: exactly like
 * the notifications dispatcher, a realtime push must never be able to break
 * the order/payment flow that triggered it. Call these only AFTER the
 * relevant transaction has committed.
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);
  private server: Server | null = null;

  /** Called once by the gateway when the socket server is ready. */
  register(server: Server): void {
    this.server = server;
  }

  /** A new order is parked for the branch to accept/reject — the New Orders tray beeps. */
  orderAwaiting(payload: OrderEventPayload): void {
    this.emitToBranchStaff(payload.branchId, REALTIME_EVENTS.orderAwaiting, payload);
  }

  /**
   * An order changed status. Fans out to the branch's staff and to the
   * customer who placed it (so their tracking screen advances live).
   */
  orderTransitioned(payload: OrderEventPayload): void {
    this.emitToBranchStaff(payload.branchId, REALTIME_EVENTS.orderTransitioned, payload);
    if (payload.customerId) {
      this.emitToCustomer(payload.customerId, REALTIME_EVENTS.orderTransitioned, payload);
    }
  }

  /**
   * A driver was put on a delivery.
   *
   * Goes to the branch's staff (the POS and Live Ops boards) **and** to the
   * driver themselves. The driver leg is the point: until it existed a driver
   * learned about a job only from the app's eight-second poll, and only while
   * the Home screen happened to be open — so "assigned" and "the driver knows"
   * were up to eight seconds and a screen-state apart.
   */
  deliveryAssigned(payload: DeliveryEventPayload): void {
    const { driverUserId, ...wire } = payload;
    this.emitToBranchStaff(payload.branchId, REALTIME_EVENTS.deliveryAssigned, wire);
    this.emitToDriver(driverUserId, REALTIME_EVENTS.deliveryAssigned, wire);
  }

  /** A delivery was returned to the pool — the branch board and the ex-driver both need it. */
  deliveryUnassigned(payload: DeliveryEventPayload): void {
    const { driverUserId, ...wire } = payload;
    this.emitToBranchStaff(payload.branchId, REALTIME_EVENTS.deliveryUnassigned, wire);
    this.emitToDriver(driverUserId, REALTIME_EVENTS.deliveryUnassigned, wire);
  }

  /**
   * A driver moved.
   *
   * Goes to the branch's staff always, and to the **one customer waiting on it**
   * when the caller says the delivery is live. Until now only staff were told,
   * so the customer's tracking map redrew on an eight-second poll: the marker
   * lagged reality by up to eight seconds on the one screen somebody watches
   * while their food gets cold.
   *
   * The customer id and order id are routing only and never reach the staff
   * copy — see `DriverLocationPayload`.
   */
  driverLocation(payload: DriverLocationPayload): void {
    const { customerId, orderId, ...staffWire } = payload;

    this.emitToBranchStaff(payload.branchId, REALTIME_EVENTS.driverLocation, staffWire);

    if (customerId && orderId) {
      const customerWire: CustomerDriverLocationPayload = {
        orderId,
        latitude: payload.latitude,
        longitude: payload.longitude,
        at: payload.at,
      };
      this.emitToCustomer(customerId, REALTIME_EVENTS.driverLocation, customerWire);
    }
  }

  /** A driver came on shift, stepped away, took a job, or finished one. */
  driverStatus(payload: DriverStatusPayload): void {
    this.safely(() => {
      const rooms = payload.branchId
        ? [ROOMS.branch(payload.branchId), ROOMS.staffAll]
        : [ROOMS.staffAll];
      this.server?.to(rooms).emit(REALTIME_EVENTS.driverStatus, payload);
    });
  }

  /**
   * Fan a staff-facing event out to a branch's staff and to every owner.
   *
   * Owners sit in `staff:all` rather than in each branch room, so one emit to
   * two rooms reaches exactly "this branch's staff + all owners" with no
   * duplicate delivery (socket.io de-dupes across rooms for a single emit).
   */
  private emitToBranchStaff(branchId: string, event: string, payload: unknown): void {
    this.safely(() => {
      this.server?.to([ROOMS.branch(branchId), ROOMS.staffAll]).emit(event, payload);
    });
  }

  /** No driver on the event means nothing to deliver — not an error, just a no-op. */
  private emitToDriver(userId: string | null | undefined, event: string, payload: unknown): void {
    if (!userId) {
      return;
    }
    this.safely(() => {
      this.server?.to(ROOMS.driver(userId)).emit(event, payload);
    });
  }

  private emitToCustomer(customerId: string, event: string, payload: unknown): void {
    this.safely(() => {
      this.server?.to(ROOMS.customer(customerId)).emit(event, payload);
    });
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.logger.warn(
        `realtime emit failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
