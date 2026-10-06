import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { BranchOpenState, acceptsOrdersNow, branchOpenState, localNowIn } from './opening-hours';
import { HoursOverrideDto, SetOpeningHoursDto } from './dto/branch-hours.dto';

/** The timezone a branch falls back to when its settings row names none. */
const DEFAULT_TIMEZONE = 'Asia/Riyadh';

const hoursSelect = {
  dayOfWeek: true,
  openMinute: true,
  closeMinute: true,
  isClosed: true,
} satisfies Prisma.BranchOpeningHoursSelect;

const overrideSelect = {
  id: true,
  date: true,
  openMinute: true,
  closeMinute: true,
  isClosed: true,
  note: true,
} satisfies Prisma.BranchHoursOverrideSelect;

@Injectable()
export class BranchHoursService {
  constructor(private readonly prisma: PrismaService) {}

  async setWeeklyHours(branchId: string, dto: SetOpeningHoursDto) {
    await this.assertBranchExists(branchId);

    await this.prisma.$transaction(async (tx) => {
      await tx.branchOpeningHours.deleteMany({ where: { branchId } });
      await tx.branchOpeningHours.createMany({
        data: dto.hours.map((h) => ({
          branchId,
          dayOfWeek: h.dayOfWeek,
          openMinute: h.openMinute,
          closeMinute: h.closeMinute,
          isClosed: h.isClosed ?? false,
        })),
      });
    });

    return this.getHours(branchId);
  }

  async getHours(branchId: string) {
    await this.assertBranchExists(branchId);

    const [hours, overrides] = await Promise.all([
      this.prisma.branchOpeningHours.findMany({
        where: { branchId },
        select: hoursSelect,
        orderBy: [{ dayOfWeek: 'asc' }, { openMinute: 'asc' }],
      }),
      this.prisma.branchHoursOverride.findMany({
        where: { branchId },
        select: overrideSelect,
        orderBy: { date: 'asc' },
      }),
    ]);

    return { hours, overrides };
  }

  async addOverride(branchId: string, dto: HoursOverrideDto) {
    await this.assertBranchExists(branchId);

    return this.prisma.branchHoursOverride.upsert({
      where: {
        branchId_date: { branchId, date: new Date(dto.date) },
      },
      update: {
        openMinute: dto.isClosed ? null : dto.openMinute,
        closeMinute: dto.isClosed ? null : dto.closeMinute,
        isClosed: dto.isClosed,
        note: dto.note,
      },
      create: {
        branchId,
        date: new Date(dto.date),
        openMinute: dto.isClosed ? null : dto.openMinute,
        closeMinute: dto.isClosed ? null : dto.closeMinute,
        isClosed: dto.isClosed,
        note: dto.note,
      },
      select: overrideSelect,
    });
  }

  async removeOverride(branchId: string, overrideId: string) {
    await this.assertBranchExists(branchId);

    const override = await this.prisma.branchHoursOverride.findFirst({
      where: { id: overrideId, branchId },
      select: { id: true },
    });
    if (!override) {
      throw new NotFoundException('Override not found.');
    }

    await this.prisma.branchHoursOverride.delete({
      where: { id: overrideId },
    });
  }

  /**
   * Whether the branch may take an order right now.
   *
   * **There is deliberately only one predicate here.** An earlier draft had two
   * — "inside configured hours" and "may take orders" — differing in exactly one
   * case, and a pair like that is how a caller picks the wrong one. The case is
   * the important one: a branch with **no schedule is unrestricted**, not
   * closed. Every branch on the platform predates the hours editor, so a
   * predicate that read an empty schedule as shut would have closed the whole
   * business the day this shipped.
   */
  async canAcceptOrdersNow(branchId: string, at: Date = new Date()): Promise<boolean> {
    return acceptsOrdersNow(await this.openState(branchId, at));
  }

  /** The full open/closed picture — what is shut, why, and when it opens. */
  async openState(branchId: string, at: Date = new Date()): Promise<BranchOpenState> {
    const [settings, hours, overrides] = await Promise.all([
      this.prisma.branchSetting.findUnique({
        where: { branchId },
        select: { timezone: true },
      }),
      this.prisma.branchOpeningHours.findMany({
        where: { branchId },
        select: { dayOfWeek: true, openMinute: true, closeMinute: true, isClosed: true },
      }),
      this.prisma.branchHoursOverride.findMany({
        where: { branchId },
        select: { date: true, openMinute: true, closeMinute: true, isClosed: true, note: true },
      }),
    ]);

    const now = localNowIn(at, settings?.timezone ?? DEFAULT_TIMEZONE);

    return branchOpenState(
      hours,
      overrides.map((o) => ({ ...o, date: toDateKey(o.date) })),
      now,
    );
  }

  /**
   * The open state of many branches at once.
   *
   * The public branch list carries this for every branch, and doing it one
   * query at a time would be four round trips per branch on a page a customer
   * opens first. Three queries total, grouped in memory.
   */
  async openStates(branchIds: readonly string[], at: Date = new Date()) {
    if (branchIds.length === 0) {
      return new Map<string, BranchOpenState>();
    }

    const ids = [...branchIds];
    const [settings, hours, overrides] = await Promise.all([
      this.prisma.branchSetting.findMany({
        where: { branchId: { in: ids } },
        select: { branchId: true, timezone: true },
      }),
      this.prisma.branchOpeningHours.findMany({
        where: { branchId: { in: ids } },
        select: {
          branchId: true,
          dayOfWeek: true,
          openMinute: true,
          closeMinute: true,
          isClosed: true,
        },
      }),
      this.prisma.branchHoursOverride.findMany({
        where: { branchId: { in: ids } },
        select: {
          branchId: true,
          date: true,
          openMinute: true,
          closeMinute: true,
          isClosed: true,
          note: true,
        },
      }),
    ]);

    const tzOf = new Map(settings.map((s) => [s.branchId, s.timezone ?? DEFAULT_TIMEZONE]));
    const out = new Map<string, BranchOpenState>();

    for (const branchId of ids) {
      const now = localNowIn(at, tzOf.get(branchId) ?? DEFAULT_TIMEZONE);
      out.set(
        branchId,
        branchOpenState(
          hours.filter((h) => h.branchId === branchId),
          overrides
            .filter((o) => o.branchId === branchId)
            .map((o) => ({ ...o, date: toDateKey(o.date) })),
          now,
        ),
      );
    }

    return out;
  }

  private async assertBranchExists(branchId: string) {
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, deletedAt: null },
      select: { id: true },
    });
    if (!branch) throw new NotFoundException('Branch not found.');
  }
}

/**
 * A stored override date as the `YYYY-MM-DD` key the rule compares on.
 *
 * The column is a `DATE`, which Prisma hands back as a `Date` at UTC midnight.
 * Formatting it with anything local-timezone-aware would shift it a day either
 * side of the line, so the UTC parts are read directly — a holiday on the 1st
 * must not become the 31st for anyone.
 */
function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}
