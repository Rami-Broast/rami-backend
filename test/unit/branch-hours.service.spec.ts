import { NotFoundException } from '@nestjs/common';

import { BranchHoursService } from '../../src/branches/branch-hours.service';

const makePrisma = () => ({
  branch: {
    findFirst: jest.fn(),
  },
  branchOpeningHours: {
    findMany: jest.fn(),
    createMany: jest.fn(),
    deleteMany: jest.fn(),
  },
  branchHoursOverride: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    upsert: jest.fn(),
    delete: jest.fn(),
  },
  branchSetting: {
    findUnique: jest.fn(),
  },
  $transaction: jest.fn() as jest.Mock<unknown, [unknown]>,
});

type MockPrisma = ReturnType<typeof makePrisma>;

function createService(prisma: MockPrisma = makePrisma()) {
  return {
    service: new BranchHoursService(
      prisma as unknown as ConstructorParameters<typeof BranchHoursService>[0],
    ),
    prisma,
  };
}

const existingBranch = { id: 'branch-1' };

describe('BranchHoursService', () => {
  describe('setWeeklyHours', () => {
    it('replaces weekly schedule in a transaction', async () => {
      const { service, prisma } = createService();
      prisma.branch.findFirst.mockResolvedValue(existingBranch);

      const txOpeningHours = {
        deleteMany: jest.fn(),
        createMany: jest.fn(),
      };

      prisma.$transaction.mockImplementation((fn) =>
        (fn as (tx: { branchOpeningHours: typeof txOpeningHours }) => unknown)({
          branchOpeningHours: txOpeningHours,
        }),
      );

      const hours = [
        { dayOfWeek: 0, openMinute: 480, closeMinute: 1380, isClosed: false },
        { dayOfWeek: 1, openMinute: 480, closeMinute: 1380 },
      ];

      prisma.branchOpeningHours.findMany.mockResolvedValue(hours);
      prisma.branchHoursOverride.findMany.mockResolvedValue([]);

      await service.setWeeklyHours('branch-1', { hours });

      expect(txOpeningHours.deleteMany).toHaveBeenCalledWith({ where: { branchId: 'branch-1' } });
      expect(txOpeningHours.createMany).toHaveBeenCalledWith({
        data: [
          {
            branchId: 'branch-1',
            dayOfWeek: 0,
            openMinute: 480,
            closeMinute: 1380,
            isClosed: false,
          },
          {
            branchId: 'branch-1',
            dayOfWeek: 1,
            openMinute: 480,
            closeMinute: 1380,
            isClosed: false,
          },
        ],
      });
    });

    it('throws NotFoundException if branch does not exist', async () => {
      const { service, prisma } = createService();
      prisma.branch.findFirst.mockResolvedValue(null);

      await expect(
        service.setWeeklyHours('nonexistent', {
          hours: [{ dayOfWeek: 0, openMinute: 0, closeMinute: 1439 }],
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getHours', () => {
    it('returns hours and overrides', async () => {
      const { service, prisma } = createService();
      prisma.branch.findFirst.mockResolvedValue(existingBranch);

      const weeklyHours = [
        { id: 'h1', dayOfWeek: 0, openMinute: 480, closeMinute: 1380, isClosed: false },
      ];
      const overrides = [
        {
          id: 'o1',
          date: new Date('2026-09-01'),
          openMinute: null,
          closeMinute: null,
          isClosed: true,
          note: 'Holiday',
        },
      ];

      prisma.branchOpeningHours.findMany.mockResolvedValue(weeklyHours);
      prisma.branchHoursOverride.findMany.mockResolvedValue(overrides);

      const result = await service.getHours('branch-1');

      expect(result).toEqual({ hours: weeklyHours, overrides });
    });

    it('throws NotFoundException if branch does not exist', async () => {
      const { service, prisma } = createService();
      prisma.branch.findFirst.mockResolvedValue(null);

      await expect(service.getHours('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('addOverride', () => {
    it('upserts an override by branchId + date', async () => {
      const { service, prisma } = createService();
      prisma.branch.findFirst.mockResolvedValue(existingBranch);

      const override = {
        id: 'o1',
        date: new Date('2026-09-01'),
        openMinute: null,
        closeMinute: null,
        isClosed: true,
        note: 'Ramadan',
      };
      prisma.branchHoursOverride.upsert.mockResolvedValue(override);

      const result = await service.addOverride('branch-1', {
        date: '2026-09-01',
        isClosed: true,
        note: 'Ramadan',
      });

      expect(result).toEqual(override);
      expect(prisma.branchHoursOverride.upsert).toHaveBeenCalledWith({
        where: { branchId_date: { branchId: 'branch-1', date: new Date('2026-09-01') } },
        update: { openMinute: null, closeMinute: null, isClosed: true, note: 'Ramadan' },
        create: {
          branchId: 'branch-1',
          date: new Date('2026-09-01'),
          openMinute: null,
          closeMinute: null,
          isClosed: true,
          note: 'Ramadan',
        },
        select: {
          id: true,
          date: true,
          openMinute: true,
          closeMinute: true,
          isClosed: true,
          note: true,
        },
      });
    });

    it('passes open/close minutes when not closed', async () => {
      const { service, prisma } = createService();
      prisma.branch.findFirst.mockResolvedValue(existingBranch);

      const override = {
        id: 'o2',
        date: new Date('2026-09-02'),
        openMinute: 600,
        closeMinute: 1200,
        isClosed: false,
        note: 'Short day',
      };
      prisma.branchHoursOverride.upsert.mockResolvedValue(override);

      await service.addOverride('branch-1', {
        date: '2026-09-02',
        openMinute: 600,
        closeMinute: 1200,
        isClosed: false,
        note: 'Short day',
      });

      const call = prisma.branchHoursOverride.upsert.mock.calls[0] as [
        { create: { openMinute: number; closeMinute: number; isClosed: boolean } },
      ];
      expect(call[0].create.openMinute).toBe(600);
      expect(call[0].create.closeMinute).toBe(1200);
      expect(call[0].create.isClosed).toBe(false);
    });

    it('throws NotFoundException if branch does not exist', async () => {
      const { service, prisma } = createService();
      prisma.branch.findFirst.mockResolvedValue(null);

      await expect(
        service.addOverride('nonexistent', { date: '2026-09-01', isClosed: true }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('removeOverride', () => {
    it('deletes an override', async () => {
      const { service, prisma } = createService();
      prisma.branch.findFirst.mockResolvedValue(existingBranch);
      prisma.branchHoursOverride.findFirst.mockResolvedValue({ id: 'o1' });

      await service.removeOverride('branch-1', 'o1');

      expect(prisma.branchHoursOverride.delete).toHaveBeenCalledWith({ where: { id: 'o1' } });
    });

    it('throws NotFoundException if override does not exist', async () => {
      const { service, prisma } = createService();
      prisma.branch.findFirst.mockResolvedValue(existingBranch);
      prisma.branchHoursOverride.findFirst.mockResolvedValue(null);

      await expect(service.removeOverride('branch-1', 'nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  /**
   * These now drive the service through the **pure** rule in
   * `opening-hours.ts`, which is where the arithmetic is tested exhaustively
   * (`test/unit/opening-hours.spec.ts`). What is left here is the part only a
   * service test can check: that the right rows are fetched and handed over.
   *
   * The query shape changed with that extraction — the day filter moved out of
   * SQL and into the rule, so `dayOfWeek` is now selected and the override is a
   * `findMany` rather than a `findUnique`. That is why these mocks did.
   */
  describe('canAcceptOrdersNow / openState', () => {
    /** 2026-01-07 is a Wednesday. */
    const WEDNESDAY = 3;

    const arrange = (
      prisma: MockPrisma,
      hours: unknown[],
      overrides: unknown[] = [],
      timezone: string | null = 'UTC',
    ) => {
      prisma.branchSetting.findUnique.mockResolvedValue(timezone ? { timezone } : null);
      prisma.branchOpeningHours.findMany.mockResolvedValue(hours);
      prisma.branchHoursOverride.findMany.mockResolvedValue(overrides);
    };

    it('returns true when current time is within regular hours', async () => {
      const { service, prisma } = createService();
      arrange(prisma, [
        { dayOfWeek: WEDNESDAY, openMinute: 480, closeMinute: 1380, isClosed: false },
      ]);

      expect(await service.canAcceptOrdersNow('branch-1', new Date('2026-01-07T10:00:00Z'))).toBe(
        true,
      );
    });

    it('returns false when current time is outside regular hours', async () => {
      const { service, prisma } = createService();
      arrange(prisma, [
        { dayOfWeek: WEDNESDAY, openMinute: 480, closeMinute: 1380, isClosed: false },
      ]);

      expect(await service.canAcceptOrdersNow('branch-1', new Date('2026-01-07T06:00:00Z'))).toBe(
        false,
      );
    });

    it('accepts orders when nobody has set a schedule at all', async () => {
      // The case the whole feature turns on, and the one that decides whether
      // shipping it is safe. Every branch on the platform predates the hours
      // editor, so reading an empty schedule as "closed" would have refused
      // every order the day this landed.
      const { service, prisma } = createService();
      arrange(prisma, []);

      const at = new Date('2026-01-07T10:00:00Z');
      expect(await service.canAcceptOrdersNow('branch-1', at)).toBe(true);
      // …and it says so honestly, rather than pretending a schedule exists.
      expect((await service.openState('branch-1', at)).configured).toBe(false);
    });

    it('returns false when the day is marked closed', async () => {
      const { service, prisma } = createService();
      arrange(prisma, [
        { dayOfWeek: WEDNESDAY, openMinute: 480, closeMinute: 1380, isClosed: true },
      ]);

      // Configured, and shut. Enforcement refuses this one.
      expect(await service.canAcceptOrdersNow('branch-1', new Date('2026-01-07T10:00:00Z'))).toBe(
        false,
      );
    });

    it('override closed takes precedence over regular hours', async () => {
      const { service, prisma } = createService();
      arrange(
        prisma,
        [{ dayOfWeek: WEDNESDAY, openMinute: 480, closeMinute: 1380, isClosed: false }],
        [
          {
            date: new Date('2026-01-07T00:00:00Z'),
            isClosed: true,
            openMinute: null,
            closeMinute: null,
            note: 'Eid holiday',
          },
        ],
      );

      const state = await service.openState('branch-1', new Date('2026-01-07T10:00:00Z'));
      expect(state.isOpen).toBe(false);
      expect(state.closedReason).toBe('override_closed');
      // The note is why this is worth showing a customer rather than a bare
      // "closed" — "Eid holiday" answers the next question.
      expect(state.note).toBe('Eid holiday');
    });

    it('override with custom hours takes precedence', async () => {
      const { service, prisma } = createService();
      arrange(
        prisma,
        [{ dayOfWeek: WEDNESDAY, openMinute: 480, closeMinute: 1380, isClosed: false }],
        [
          {
            date: new Date('2026-01-07T00:00:00Z'),
            isClosed: false,
            openMinute: 600,
            closeMinute: 720,
            note: 'Ramadan hours',
          },
        ],
      );

      expect(await service.canAcceptOrdersNow('branch-1', new Date('2026-01-07T11:00:00Z'))).toBe(
        true,
      );
    });

    it('override with custom hours rejects time outside range', async () => {
      const { service, prisma } = createService();
      arrange(
        prisma,
        [{ dayOfWeek: WEDNESDAY, openMinute: 480, closeMinute: 1380, isClosed: false }],
        [
          {
            date: new Date('2026-01-07T00:00:00Z'),
            isClosed: false,
            openMinute: 600,
            closeMinute: 720,
            note: null,
          },
        ],
      );

      expect(await service.canAcceptOrdersNow('branch-1', new Date('2026-01-07T13:00:00Z'))).toBe(
        false,
      );
    });

    it('defaults to Asia/Riyadh when no settings exist', async () => {
      const { service, prisma } = createService();
      // Riyadh is UTC+3, so 07:00Z is 10:00 local — inside 08:00–23:00, and
      // outside it if the timezone were ignored.
      arrange(
        prisma,
        [{ dayOfWeek: WEDNESDAY, openMinute: 480, closeMinute: 1380, isClosed: false }],
        [],
        null,
      );

      expect(await service.canAcceptOrdersNow('branch-1', new Date('2026-01-07T07:00:00Z'))).toBe(
        true,
      );
      expect(await service.canAcceptOrdersNow('branch-1', new Date('2026-01-07T02:00:00Z'))).toBe(
        false,
      );
    });

    it('handles split shifts — open during second window', async () => {
      const { service, prisma } = createService();
      arrange(prisma, [
        { dayOfWeek: WEDNESDAY, openMinute: 720, closeMinute: 900, isClosed: false },
        { dayOfWeek: WEDNESDAY, openMinute: 1020, closeMinute: 1380, isClosed: false },
      ]);

      expect(await service.canAcceptOrdersNow('branch-1', new Date('2026-01-07T18:00:00Z'))).toBe(
        true,
      );
    });

    it('handles split shifts — closed during gap, and says when it reopens', async () => {
      const { service, prisma } = createService();
      arrange(prisma, [
        { dayOfWeek: WEDNESDAY, openMinute: 720, closeMinute: 900, isClosed: false },
        { dayOfWeek: WEDNESDAY, openMinute: 1020, closeMinute: 1380, isClosed: false },
      ]);

      const state = await service.openState('branch-1', new Date('2026-01-07T16:00:00Z'));
      expect(state.isOpen).toBe(false);
      // "Closed" and "opens at 17:00" are different things to a hungry customer.
      expect(state.opensAtMinute).toBe(1020);
    });
  });
});
