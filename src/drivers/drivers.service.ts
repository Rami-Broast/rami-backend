import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Driver, DeliveryStatus, Prisma } from '@prisma/client';

import { Actor } from '../auth/types/actor';
import {
  assertBranchAccess,
  branchScopeFilter,
  resolveRequestedBranches,
} from '../branches/branch-scope';
import { buildPaginationMeta } from '../common/dto/pagination.dto';
import { AppConfigService } from '../config/config.module';
import { toCoordinate } from '../common/geo';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  CreateDriverProfileDto,
  ListDriversQueryDto,
  UpdateDriverProfileDto,
} from './dto/driver.dto';

/** Delivery statuses that mean a driver currently holds an active job. */
const ACTIVE_DELIVERY_STATUSES: DeliveryStatus[] = [
  DeliveryStatus.ASSIGNED,
  DeliveryStatus.PICKED_UP,
  DeliveryStatus.OUT_FOR_DELIVERY,
];

/** The DRIVER system role, seeded in `prisma/seed/permissions.ts`. */
const DRIVER_ROLE = 'DRIVER';

/** The safe view of a driver returned to staff and to the driver themselves. */
const driverView = {
  id: true,
  userId: true,
  // No new information to anyone who can read this row — `listForStaff` is
  // branch-scoped, so a branch admin only ever sees their own branch's drivers
  // — and the realtime status event needs it to know which branch room to
  // reach.
  branchId: true,
  licenseNumber: true,
  vehicleType: true,
  vehiclePlate: true,
  isOnline: true,
  isAvailable: true,
  currentLatitude: true,
  currentLongitude: true,
  lastLocationAt: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { fullName: true, email: true, phone: true } },
  /**
   * How many deliveries this driver is currently carrying.
   *
   * `isAvailable` is a yes/no, and a dispatcher choosing between two busy
   * drivers needs the number: "on a job" and "on three jobs" are a different
   * decision, and since a second delivery may now be stacked onto a driver
   * (see {@link DriversService.assertCanTakeAnotherJob}) a board that only
   * showed the flag would offer both as equally sensible.
   */
  _count: { select: { deliveries: { where: { status: { in: ACTIVE_DELIVERY_STATUSES } } } } },
} satisfies Prisma.DriverSelect;

/**
 * Drivers (Phase 14).
 *
 * A driver is a staff account with the DRIVER role plus this operational
 * profile — vehicle, shift status and live location.
 *
 * **`isOnline` is the shift switch; `isAvailable` means "carrying nothing".**
 * `isAvailable` follows `isOnline`, and is held `false` for as long as the
 * driver holds *any* active delivery — it goes back to true only when the last
 * one closes out ({@link releaseAfterDelivery}).
 *
 * A busy driver **can** now be given another drop: batching drops onto one run
 * is how a small fleet works, and refusing it left food on the pass whenever
 * everyone was out. The ceiling on that is `DRIVER_MAX_ACTIVE_DELIVERIES`, and
 * the whole rule lives in {@link assertCanTakeAnotherJob}.
 *
 * That leaves `isAvailable: false` meaning two different things, and the
 * difference matters: **carrying work** (assignable, up to the ceiling) versus
 * **stepped away** ({@link setAvailability} — a break, only possible while
 * holding nothing, and not assignable). The active-delivery count is what tells
 * them apart, which is why the assignment guard reads it rather than the flag
 * alone. Without that, making busy drivers assignable would have silently
 * turned the break switch into a control that controls nothing.
 *
 * Every self-service method resolves the caller's own driver profile by
 * `userId`, never by an id supplied in the request, so one driver can never
 * read or change another's profile or location by guessing an id.
 */
@Injectable()
export class DriversService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly config: AppConfigService,
  ) {}

  // ===========================================================================
  // Staff
  // ===========================================================================

  async createProfile(actor: Actor, dto: CreateDriverProfileDto) {
    const user = await this.prisma.user.findFirst({
      where: { id: dto.userId, deletedAt: null },
      select: { id: true, roles: { select: { role: { select: { name: true } } } } },
    });

    if (!user) {
      throw new NotFoundException('Staff user not found.');
    }

    const hasDriverRole = user.roles.some((grant) => grant.role.name === DRIVER_ROLE);
    if (!hasDriverRole) {
      throw new BadRequestException('This user does not hold the DRIVER role.');
    }

    const existing = await this.prisma.driver.findUnique({ where: { userId: dto.userId } });
    if (existing) {
      throw new ConflictException('A driver profile already exists for this user.');
    }

    // Inherit the branch from the user's DRIVER role grant when the caller
    // does not name one. `staff:create` requires a branch for that role, so it
    // is nearly always there — and a driver with no branch is visible to owners
    // only, which is the safe direction rather than a silent org-wide profile.
    const branchId = dto.branchId ?? (await this.resolveDriverBranch(dto.userId));

    if (branchId) {
      assertBranchAccess(actor, branchId);
    }

    const created = await this.prisma.driver.create({
      data: {
        userId: dto.userId,
        branchId,
        licenseNumber: dto.licenseNumber,
        vehicleType: dto.vehicleType,
        vehiclePlate: dto.vehiclePlate,
      },
      select: driverView,
    });

    return serializeDriver(created);
  }

  /** The branch a driver's user account is assigned to, if any. */
  private async resolveDriverBranch(userId: string): Promise<string | null> {
    const grant = await this.prisma.userRole.findFirst({
      where: { userId, role: { name: DRIVER_ROLE }, branchId: { not: null } },
      select: { branchId: true },
    });

    return grant?.branchId ?? null;
  }

  async listForStaff(actor: Actor, query: ListDriversQueryDto) {
    // Branch-scoped. This listing carries the driver's name, email, licence
    // number, vehicle plate and **live GPS coordinates**, and returned every
    // driver in the organisation to any branch admin — the whole fleet's
    // whereabouts to someone entitled to one branch's.
    const where: Prisma.DriverWhereInput = {
      deletedAt: null,
      ...resolveRequestedBranches(actor, query.branchId),
      ...(query.isOnline !== undefined ? { isOnline: query.isOnline } : {}),
      ...(query.isAvailable !== undefined ? { isAvailable: query.isAvailable } : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.driver.findMany({
        where,
        select: driverView,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.driver.count({ where }),
    ]);

    return { data: data.map(serializeDriver), meta: buildPaginationMeta(total, query) };
  }

  /**
   * One driver, within the caller's branch scope.
   *
   * An out-of-scope driver returns the same 404 as one that does not exist, so
   * a branch admin cannot confirm another branch's drivers by probing ids —
   * the discipline the order and delivery lookups already follow.
   */
  async getForStaff(actor: Actor, id: string) {
    const driver = await this.prisma.driver.findFirst({
      where: { id, deletedAt: null, ...branchScopeFilter(actor) },
      select: driverView,
    });

    if (!driver) {
      throw new NotFoundException('Driver not found.');
    }

    return serializeDriver(driver);
  }

  async updateProfile(actor: Actor, id: string, dto: UpdateDriverProfileDto) {
    await this.getForStaff(actor, id);

    const updated = await this.prisma.driver.update({
      where: { id },
      data: {
        licenseNumber: dto.licenseNumber,
        vehicleType: dto.vehicleType,
        vehiclePlate: dto.vehiclePlate,
      },
      select: driverView,
    });

    return serializeDriver(updated);
  }

  /** Soft-deletes a driver profile and pulls them off shift immediately. */
  /**
   * Retires a driver profile.
   *
   * Refuses while the driver still holds work. Deactivating mid-job used to
   * succeed silently and strand every delivery they held: the driver could no
   * longer act on them, and before `unassignDriver` existed nobody else could
   * take them either, so the only way out was cancelling the customer's order.
   *
   * The refusal names the count rather than doing something clever with it —
   * whether those jobs should be reassigned or the deliveries cancelled is a
   * dispatch decision, and it belongs to the person who can see the road.
   */
  async deactivate(actor: Actor, id: string) {
    await this.getForStaff(actor, id);

    const active = await this.prisma.delivery.count({
      where: {
        driverId: id,
        status: {
          in: [DeliveryStatus.ASSIGNED, DeliveryStatus.PICKED_UP, DeliveryStatus.OUT_FOR_DELIVERY],
        },
      },
    });

    if (active > 0) {
      throw new ConflictException(
        `This driver still has ${active} delivery/deliveries in progress. Reassign or complete them first.`,
      );
    }

    const retired = await this.prisma.driver.update({
      where: { id },
      data: { deletedAt: new Date(), isOnline: false, isAvailable: false },
      select: driverView,
    });

    this.announce(retired);

    return serializeDriver(retired);
  }

  // ===========================================================================
  // Driver self-service
  // ===========================================================================

  /**
   * Resolves the calling actor's own driver profile. Exported for the delivery
   * module (Phase 14), which needs the same ownership resolution to prove a
   * delivery belongs to the driver acting on it — resolving it here rather
   * than duplicating the query keeps "who am I" answered in exactly one place.
   */
  async getOwnDriverRecord(actor: Actor): Promise<Driver> {
    const driver = await this.prisma.driver.findFirst({
      where: { userId: actor.id, deletedAt: null },
    });

    if (!driver) {
      throw new NotFoundException('No driver profile exists for this account.');
    }

    return driver;
  }

  async getOwnProfile(actor: Actor) {
    const driver = await this.getOwnDriverRecord(actor);

    const own = await this.prisma.driver.findUniqueOrThrow({
      where: { id: driver.id },
      select: driverView,
    });

    return serializeDriver(own);
  }

  async setOnlineStatus(actor: Actor, isOnline: boolean) {
    const driver = await this.getOwnDriverRecord(actor);

    const data: Prisma.DriverUpdateInput = { isOnline };
    if (!isOnline) {
      // Never available while off shift.
      data.isAvailable = false;
    } else if (!(await this.hasActiveDelivery(driver.id))) {
      data.isAvailable = true;
    }

    const updated = await this.prisma.driver.update({
      where: { id: driver.id },
      data,
      select: driverView,
    });

    // The whole point of the event: a counter with the driver picker already
    // open sees this driver appear the moment they start their shift, instead
    // of "no available drivers" until somebody thinks to close and reopen it.
    this.announce(updated);

    return serializeDriver(updated);
  }

  async setAvailability(actor: Actor, isAvailable: boolean) {
    const driver = await this.getOwnDriverRecord(actor);

    if (!driver.isOnline) {
      throw new BadRequestException('Go online before changing availability.');
    }

    if (await this.hasActiveDelivery(driver.id)) {
      throw new ConflictException(
        'Availability is controlled automatically while a delivery is in progress.',
      );
    }

    const updated = await this.prisma.driver.update({
      where: { id: driver.id },
      data: { isAvailable },
      select: driverView,
    });

    this.announce(updated);

    return serializeDriver(updated);
  }

  async updateLocation(actor: Actor, latitude: number, longitude: number) {
    const driver = await this.getOwnDriverRecord(actor);

    const updated = await this.prisma.driver.update({
      where: { id: driver.id },
      data: { currentLatitude: latitude, currentLongitude: longitude, lastLocationAt: new Date() },
      select: driverView,
    });

    // Realtime: push the ping to the staff watching the branch this driver is
    // currently delivering for, so Live Ops tracks movement without polling.
    // An idle driver with no active delivery has no branch context, so no
    // event is pushed — which also matches the location policy (only stream
    // during an active delivery).
    const activeDelivery = await this.prisma.delivery.findFirst({
      where: { driverId: driver.id, status: { in: ACTIVE_DELIVERY_STATUSES } },
      select: {
        branchId: true,
        status: true,
        orderId: true,
        order: { select: { customerId: true } },
      },
    });
    if (activeDelivery) {
      // The customer is told only while the food is actually travelling —
      // `PICKED_UP` and `OUT_FOR_DELIVERY`, the same window in which the driver
      // may ring them (`src/delivery/customer-contact.ts`). A delivery merely
      // ASSIGNED is a driver who may still be at another drop or at the
      // counter, and showing that as "your driver" is both wrong and a position
      // nobody agreed to share. Staff see every ping regardless: dispatch is
      // what the branch board is for.
      const liveForCustomer =
        activeDelivery.status === DeliveryStatus.PICKED_UP ||
        activeDelivery.status === DeliveryStatus.OUT_FOR_DELIVERY;

      this.realtime.driverLocation({
        driverId: driver.id,
        branchId: activeDelivery.branchId,
        latitude,
        longitude,
        at: new Date().toISOString(),
        customerId: liveForCustomer ? activeDelivery.order.customerId : null,
        orderId: liveForCustomer ? activeDelivery.orderId : null,
      });
    }

    return serializeDriver(updated);
  }

  // ===========================================================================
  // Workload — used by the delivery module
  // ===========================================================================

  /** How many deliveries this driver is carrying right now. */
  activeDeliveryCount(driverId: string, tx?: Prisma.TransactionClient): Promise<number> {
    return (tx ?? this.prisma).delivery.count({
      where: { driverId, status: { in: ACTIVE_DELIVERY_STATUSES } },
    });
  }

  /** True while the driver holds a delivery that has been assigned but not yet closed out. */
  async hasActiveDelivery(driverId: string): Promise<boolean> {
    return (await this.activeDeliveryCount(driverId)) > 0;
  }

  /**
   * Refuses a stacked assignment only when the driver is already at the
   * ceiling.
   *
   * A driver used to be assignable only while `isAvailable` — so the counter
   * could not hand a second drop-off to the person already going that way,
   * even when both orders were for the same street and the alternative was the
   * food sitting on the pass until somebody came back. Batching two or three
   * drops onto one run is how a small fleet actually works, and refusing it was
   * a rule nobody had chosen.
   *
   * What replaces it is a **ceiling, not a policy**: how many drops one driver
   * should carry is the owner's call (it depends on the vehicle, the bags and
   * the distances), so it is config — `DRIVER_MAX_ACTIVE_DELIVERIES` — exactly
   * like the VAT rate and the loyalty earn rate, and the default is a safety
   * limit rather than a business answer. **Confirm the number with the owner
   * before launch.** It exists so a mis-click cannot put twelve orders on one
   * motorcycle, not to express a view about how many is right.
   */
  async assertCanTakeAnotherJob(tx: Prisma.TransactionClient, driverId: string): Promise<number> {
    // Lock the driver row before reading anything about them.
    //
    // The count below is only a guard if concurrent dispatchers take it in
    // turn. Postgres runs at READ COMMITTED here, so without this two counters
    // pressing Assign at the same moment each read the same "carrying 2", each
    // pass, and both write — the ceiling is exceeded by exactly as many people
    // as happened to press at once. The old code did not need this because its
    // guard was a conditional `isAvailable: true → false` update, which the
    // database serialised for free; making a busy driver assignable removed
    // that, so the lock is what replaces it. The concurrency suite has a test
    // that fails without this line.
    await tx.$queryRaw`SELECT id FROM "Driver" WHERE id = ${driverId} FOR UPDATE`;

    const [driver, held] = await Promise.all([
      tx.driver.findUniqueOrThrow({
        where: { id: driverId },
        select: { isOnline: true, isAvailable: true },
      }),
      this.activeDeliveryCount(driverId, tx),
    ]);

    if (!driver.isOnline) {
      throw new BadRequestException('This driver is no longer on shift.');
    }

    // **Stepped away, not busy.** `isAvailable` is false in two situations that
    // used to be the same one: carrying a job, and deliberately taking a break
    // (`setAvailability`, which is only allowed while holding nothing). Making
    // a busy driver assignable would otherwise have quietly made the break
    // switch do nothing at all — a control that controls nothing, which is
    // worse than no control. The active count is what separates them: nothing
    // in hand and not available means they asked not to be given work.
    if (held === 0 && !driver.isAvailable) {
      throw new BadRequestException('This driver has stepped away and is not taking jobs.');
    }

    if (held >= this.maxActiveDeliveries) {
      throw new ConflictException(
        `This driver is already carrying ${held} deliveries, which is the current limit. Finish or reassign one first.`,
      );
    }

    return held;
  }

  /**
   * Frees a driver once their delivery closes out — **if it was their last
   * one**.
   *
   * This used to set `isAvailable: true` unconditionally, which was correct
   * only while a driver could hold exactly one job. With stacked assignments it
   * would put a driver still carrying two more drops back into the "free" pool
   * the moment the first was signed for, and the boards would offer them as
   * idle while they were riding.
   *
   * Going offline mid-run must also survive this: `isOnline: true` is in the
   * condition, so finishing a delivery after clocking off does not silently put
   * the driver back on shift.
   */
  async releaseAfterDelivery(tx: Prisma.TransactionClient, driverId: string): Promise<void> {
    const stillCarrying = await this.activeDeliveryCount(driverId, tx);
    if (stillCarrying > 0) {
      return;
    }
    await tx.driver.updateMany({
      where: { id: driverId, isOnline: true },
      data: { isAvailable: true },
    });
  }

  /**
   * Tells the boards a driver's shift state changed.
   *
   * Best-effort and post-write, like every other emit on this platform: a
   * realtime push must never be able to fail a driver going on shift. A driver
   * with no branch reaches owners only, which matches who can see them at all
   * — `listForStaff` is branch-scoped and an unassigned driver deliberately
   * matches no branch filter.
   */
  private announce(row: DriverRow): void {
    this.realtime.driverStatus({
      driverId: row.id,
      branchId: row.branchId,
      isOnline: row.isOnline,
      isAvailable: row.isAvailable,
      activeDeliveryCount: row._count.deliveries,
    });
  }

  /** @see assertCanTakeAnotherJob — a safety ceiling, not an owner decision. */
  private get maxActiveDeliveries(): number {
    return this.config.delivery.maxActiveDeliveriesPerDriver;
  }
}

type DriverRow = Prisma.DriverGetPayload<{ select: typeof driverView }>;

/**
 * The API shape of a driver row.
 *
 * Two conversions, both at this one boundary:
 *
 *  - **Coordinates become numbers.** `Prisma.Decimal` serialises to a JSON
 *    *string*, so `/drivers` was shipping `"24.72"` where every client's type
 *    said `number`. On the owner's live map a string is not a `LatLng`: the pin
 *    never landed and the map stayed on its fallback centre, which is what
 *    "the map opens somewhere random" was. See `src/common/geo.ts`.
 *  - **`_count.deliveries` becomes `activeDeliveryCount`.** Prisma's shape is
 *    an implementation detail of the query; the clients get a name that says
 *    what the number is.
 */
function serializeDriver(row: DriverRow) {
  const { _count, ...rest } = row;
  return {
    ...rest,
    currentLatitude: toCoordinate(rest.currentLatitude),
    currentLongitude: toCoordinate(rest.currentLongitude),
    activeDeliveryCount: _count.deliveries,
  };
}
