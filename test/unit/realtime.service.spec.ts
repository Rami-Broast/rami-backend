import type { Server } from 'socket.io';

import {
  DeliveryEventPayload,
  REALTIME_EVENTS,
  ROOMS,
  RealtimeService,
} from '../../src/realtime/realtime.service';

/**
 * A stand-in for socket.io's `Server` that records what was emitted where.
 *
 * `to()` returns itself so a chained `.to(rooms).emit(event, payload)` works,
 * and each emit is recorded with the rooms that were targeted. That pairing is
 * the whole point: these tests are about **routing**, and an event delivered to
 * the wrong room is not a rendering bug in some client — it is one customer's
 * order landing in another's app, or a branch's traffic reaching a driver.
 */
class FakeServer {
  readonly emitted: { rooms: string[]; event: string; payload: unknown }[] = [];
  private pending: string[] = [];

  to(rooms: string | string[]): this {
    this.pending = Array.isArray(rooms) ? [...rooms] : [rooms];
    return this;
  }

  emit(event: string, payload: unknown): boolean {
    this.emitted.push({ rooms: this.pending, event, payload });
    this.pending = [];
    return true;
  }
}

function serviceWithServer(): { service: RealtimeService; server: FakeServer } {
  const service = new RealtimeService();
  const server = new FakeServer();
  service.register(server as unknown as Server);
  return { service, server };
}

const BRANCH = 'branch-1';
const DRIVER_USER = 'driver-user-1';

function payload(overrides: Partial<DeliveryEventPayload> = {}): DeliveryEventPayload {
  return {
    deliveryId: 'delivery-1',
    orderId: 'order-1',
    branchId: BRANCH,
    driverId: 'driver-1',
    status: 'ASSIGNED',
    ...overrides,
  };
}

describe('RealtimeService', () => {
  describe('deliveryAssigned', () => {
    it('reaches the branch, every owner, and the driver themselves', () => {
      const { service, server } = serviceWithServer();

      service.deliveryAssigned(payload({ driverUserId: DRIVER_USER }));

      const events = server.emitted.filter((e) => e.event === REALTIME_EVENTS.deliveryAssigned);
      expect(events).toHaveLength(2);
      // The branch's staff and all owners in one emit — socket.io de-dupes
      // across rooms, so an owner assigned to this branch is not told twice.
      expect(events[0].rooms).toEqual([ROOMS.branch(BRANCH), ROOMS.staffAll]);
      // The leg this exists for: until it was added a driver learned about a
      // job only from their app's poll.
      expect(events[1].rooms).toEqual([ROOMS.driver(DRIVER_USER)]);
    });

    it('does not put the driver’s user id on the wire', () => {
      const { service, server } = serviceWithServer();

      service.deliveryAssigned(payload({ driverUserId: DRIVER_USER }));

      // `driverUserId` is routing, not content. It names the account behind a
      // driver, and the branch-facing copy of this event is read by every
      // owner's browser.
      for (const emitted of server.emitted) {
        expect(emitted.payload).not.toHaveProperty('driverUserId');
      }
      expect(server.emitted[0].payload).toMatchObject({
        deliveryId: 'delivery-1',
        driverId: 'driver-1',
      });
    });

    it('still tells the branch when no driver user id is carried', () => {
      const { service, server } = serviceWithServer();

      service.deliveryAssigned(payload({ driverUserId: null }));

      expect(server.emitted).toHaveLength(1);
      expect(server.emitted[0].rooms).toEqual([ROOMS.branch(BRANCH), ROOMS.staffAll]);
    });
  });

  describe('deliveryUnassigned', () => {
    it('tells the branch and the driver who just lost the job', () => {
      const { service, server } = serviceWithServer();

      service.deliveryUnassigned(
        payload({ status: 'PENDING_ASSIGNMENT', driverUserId: DRIVER_USER }),
      );

      const events = server.emitted.filter((e) => e.event === REALTIME_EVENTS.deliveryUnassigned);
      expect(events.map((e) => e.rooms)).toEqual([
        [ROOMS.branch(BRANCH), ROOMS.staffAll],
        [ROOMS.driver(DRIVER_USER)],
      ]);
    });
  });

  describe('driverLocation', () => {
    const ping = (over: Record<string, unknown> = {}) => ({
      driverId: 'driver-1',
      branchId: BRANCH,
      latitude: 24.7241,
      longitude: 46.6812,
      at: '2026-09-08T03:00:00.000Z',
      ...over,
    });

    it('reaches the branch always, and the customer only when one is carried', () => {
      const { service, server } = serviceWithServer();

      service.driverLocation(ping({ customerId: 'cust-1', orderId: 'order-1' }));

      const events = server.emitted.filter((e) => e.event === REALTIME_EVENTS.driverLocation);
      expect(events).toHaveLength(2);
      expect(events[0].rooms).toEqual([ROOMS.branch(BRANCH), ROOMS.staffAll]);
      // The leg this exists for: the customer's map used to redraw on an
      // eight-second poll.
      expect(events[1].rooms).toEqual([ROOMS.customer('cust-1')]);
    });

    it('tells only the branch when the delivery is not live for a customer', () => {
      const { service, server } = serviceWithServer();

      // A driver merely ASSIGNED may still be at another drop or at the
      // counter. The caller decides; this asserts the service honours it.
      service.driverLocation(ping({ customerId: null, orderId: null }));

      expect(server.emitted).toHaveLength(1);
      expect(server.emitted[0].rooms).toEqual([ROOMS.branch(BRANCH), ROOMS.staffAll]);
    });

    it('never puts the customer id on the staff wire', () => {
      const { service, server } = serviceWithServer();

      service.driverLocation(ping({ customerId: 'cust-1', orderId: 'order-1' }));

      // Routing, not content — the branch copy is read by every owner's browser.
      const staff = server.emitted[0];
      expect(staff.payload).not.toHaveProperty('customerId');
      expect(staff.payload).not.toHaveProperty('orderId');
    });

    it('tells the customer where their food is and nothing else', () => {
      const { service, server } = serviceWithServer();

      service.driverLocation(ping({ customerId: 'cust-1', orderId: 'order-1' }));

      // Smallest payload that answers "where is my food". A customer has no use
      // for the driver's id or the branch's.
      expect(server.emitted[1].payload).toEqual({
        orderId: 'order-1',
        latitude: 24.7241,
        longitude: 46.6812,
        at: '2026-09-08T03:00:00.000Z',
      });
    });
  });

  describe('orderTransitioned', () => {
    it('reaches the branch and the customer who placed it, and nobody else', () => {
      const { service, server } = serviceWithServer();

      service.orderTransitioned({
        orderId: 'order-1',
        orderNumber: '1000000',
        branchId: BRANCH,
        status: 'DRIVER_ASSIGNED',
        customerId: 'customer-1',
      });

      expect(server.emitted.map((e) => e.rooms)).toEqual([
        [ROOMS.branch(BRANCH), ROOMS.staffAll],
        [ROOMS.customer('customer-1')],
      ]);
    });
  });

  it('is a silent no-op with no transport registered', () => {
    // Every integration test that composes a feature module without starting
    // the socket server relies on this. An emit must never be the thing that
    // fails an order.
    const service = new RealtimeService();
    expect(() => service.deliveryAssigned(payload({ driverUserId: DRIVER_USER }))).not.toThrow();
  });
});
