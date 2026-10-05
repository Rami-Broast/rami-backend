import {
  acceptsOrdersNow,
  branchOpenState,
  formatMinute,
  isMinuteInRange,
  localNowIn,
  type HoursOverride,
  type OpeningHoursEntry,
} from '../../src/branches/opening-hours';

const SUN = 0;
const FRI = 5;
const SAT = 6;
const WED = 3;

const at = (dayOfWeek: number, minuteOfDay: number, date = '2026-01-07') => ({
  date,
  dayOfWeek,
  minuteOfDay,
});

const day = (
  dayOfWeek: number,
  openMinute: number,
  closeMinute: number,
  isClosed = false,
): OpeningHoursEntry => ({ dayOfWeek, openMinute, closeMinute, isClosed });

/** 09:00–23:00, every day. */
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6].map((d) => day(d, 540, 1380));

describe('branchOpenState', () => {
  describe('an unconfigured branch', () => {
    /**
     * The rule the entire feature is safe to ship because of. Every branch on
     * this platform predates the hours editor and therefore has an empty
     * schedule; reading that as "closed" would have refused every order on the
     * day this landed. `configured: false` is its own outcome for exactly that
     * reason, rather than something each caller has to remember to special-case.
     */
    it('is unrestricted, not closed', () => {
      const state = branchOpenState([], [], at(WED, 180));
      expect(state.configured).toBe(false);
      expect(state.isOpen).toBe(true);
      expect(state.closedReason).toBeNull();
      expect(acceptsOrdersNow(state)).toBe(true);
    });

    it('is unrestricted even at 03:00, when a configured branch would be shut', () => {
      expect(acceptsOrdersNow(branchOpenState([], [], at(WED, 180)))).toBe(true);
      expect(acceptsOrdersNow(branchOpenState(EVERY_DAY, [], at(WED, 180)))).toBe(false);
    });
  });

  describe('the ordinary day', () => {
    it('is open inside the window and shut outside it', () => {
      expect(branchOpenState(EVERY_DAY, [], at(WED, 600)).isOpen).toBe(true);
      expect(branchOpenState(EVERY_DAY, [], at(WED, 480)).isOpen).toBe(false);
    });

    it('closes on the closing minute, not a minute after', () => {
      // A branch closing at 23:00 is shut at 23:00. Off-by-one here is an order
      // the kitchen finds after everyone has gone home.
      expect(branchOpenState(EVERY_DAY, [], at(WED, 1379)).isOpen).toBe(true);
      expect(branchOpenState(EVERY_DAY, [], at(WED, 1380)).isOpen).toBe(false);
    });

    it('says when it opens, so a screen need not just say "closed"', () => {
      const state = branchOpenState(EVERY_DAY, [], at(WED, 400));
      expect(state.closedReason).toBe('outside_hours');
      expect(state.opensAtMinute).toBe(540);
    });

    it('says when it closes while open, so a customer can be warned', () => {
      expect(branchOpenState(EVERY_DAY, [], at(WED, 600)).closesAtMinute).toBe(1380);
    });

    it('distinguishes a day off from being between shifts', () => {
      // Different sentences to a customer: one will open later today, the other
      // will not open at all.
      const closedDay = branchOpenState([day(WED, 540, 1380, true)], [], at(WED, 600));
      expect(closedDay.closedReason).toBe('day_closed');
      expect(closedDay.opensAtMinute).toBeNull();

      const betweenShifts = branchOpenState(
        [day(WED, 720, 900), day(WED, 1020, 1380)],
        [],
        at(WED, 960),
      );
      expect(betweenShifts.closedReason).toBe('outside_hours');
      expect(betweenShifts.opensAtMinute).toBe(1020);
    });

    it('ignores another day’s hours', () => {
      expect(branchOpenState([day(SUN, 540, 1380)], [], at(WED, 600)).isOpen).toBe(false);
    });
  });

  describe('a window that crosses midnight', () => {
    /**
     * 18:00–02:00 is an ordinary restaurant shift, and at 01:00 the window that
     * covers it lives on **yesterday's** row. Reading only today's rows reports
     * a late-night kitchen shut for the two hours it is busiest, and the branch
     * would have had to know to add a phantom 00:00–02:00 row to work around it.
     */
    const LATE = [day(FRI, 1080, 120)];

    it('is open before midnight on the day itself', () => {
      expect(branchOpenState(LATE, [], at(FRI, 1200)).isOpen).toBe(true);
    });

    it('is open after midnight, on the following day', () => {
      expect(branchOpenState(LATE, [], at(SAT, 60)).isOpen).toBe(true);
    });

    it('is shut once the late window has actually ended', () => {
      expect(branchOpenState(LATE, [], at(SAT, 121)).isOpen).toBe(false);
    });

    it('does not leak into the day after that', () => {
      expect(branchOpenState(LATE, [], at(SUN, 60)).isOpen).toBe(false);
    });

    it('wraps the week — Saturday night reaches into Sunday', () => {
      expect(branchOpenState([day(SAT, 1080, 120)], [], at(SUN, 60)).isOpen).toBe(true);
    });
  });

  describe('a date override', () => {
    const override = (o: Partial<HoursOverride> = {}): HoursOverride => ({
      date: '2026-01-07',
      isClosed: false,
      openMinute: 600,
      closeMinute: 720,
      note: null,
      ...o,
    });

    it('replaces the weekly hours outright — that is what makes it useful', () => {
      // Ramadan and Eid are not variations on the weekly pattern; they suspend
      // it. Merging the two would give a branch its normal evening back on a
      // day it had explicitly shortened.
      expect(branchOpenState(EVERY_DAY, [override()], at(WED, 660)).isOpen).toBe(true);
      expect(branchOpenState(EVERY_DAY, [override()], at(WED, 900)).isOpen).toBe(false);
    });

    it('closes the day, and carries the reason it was closed', () => {
      const state = branchOpenState(
        EVERY_DAY,
        [override({ isClosed: true, openMinute: null, closeMinute: null, note: 'Eid holiday' })],
        at(WED, 600),
      );
      expect(state.isOpen).toBe(false);
      expect(state.closedReason).toBe('override_closed');
      // "Closed for Eid" answers the customer's next question; "closed" does not.
      expect(state.note).toBe('Eid holiday');
    });

    it('treats an override with no times as a closure, not as all day', () => {
      // A half-filled override must fail shut. Reading missing times as
      // "open around the clock" is the direction that costs an unstaffed night.
      const state = branchOpenState(
        EVERY_DAY,
        [override({ isClosed: false, openMinute: null, closeMinute: null })],
        at(WED, 600),
      );
      expect(state.isOpen).toBe(false);
      expect(state.closedReason).toBe('override_closed');
    });

    it('applies only on its own date', () => {
      const state = branchOpenState(
        EVERY_DAY,
        [override({ date: '2026-01-08', isClosed: true })],
        at(WED, 600, '2026-01-07'),
      );
      expect(state.isOpen).toBe(true);
    });

    it('overrides an unconfigured branch too — a holiday closes it', () => {
      // Otherwise a branch with no weekly schedule could never be shut for a
      // public holiday, which is the one thing an owner would reach for first.
      const state = branchOpenState([], [override({ isClosed: true })], at(WED, 600));
      expect(acceptsOrdersNow(state)).toBe(false);
    });
  });
});

describe('isMinuteInRange', () => {
  it('handles a normal window', () => {
    expect(isMinuteInRange(600, 540, 1380)).toBe(true);
    expect(isMinuteInRange(1400, 540, 1380)).toBe(false);
  });

  it('handles a window that wraps midnight', () => {
    expect(isMinuteInRange(1200, 1080, 120)).toBe(true);
    expect(isMinuteInRange(60, 1080, 120)).toBe(true);
    expect(isMinuteInRange(600, 1080, 120)).toBe(false);
  });
});

describe('formatMinute', () => {
  it('renders a wall-clock time', () => {
    expect(formatMinute(540)).toBe('09:00');
    expect(formatMinute(0)).toBe('00:00');
    expect(formatMinute(1439)).toBe('23:59');
  });

  it('has nothing to say about a missing time', () => {
    expect(formatMinute(null)).toBeNull();
    expect(formatMinute(undefined)).toBeNull();
    expect(formatMinute(Number.NaN)).toBeNull();
  });
});

describe('localNowIn', () => {
  /**
   * The branch's own wall clock, not the server's. Getting this wrong shows up
   * as a branch that opens three hours late — and only for whoever is looking
   * at the time it happens.
   */
  it('reads the time in the branch’s timezone', () => {
    const utcMorning = new Date('2026-01-07T07:00:00Z');
    expect(localNowIn(utcMorning, 'UTC').minuteOfDay).toBe(420);
    expect(localNowIn(utcMorning, 'Asia/Riyadh').minuteOfDay).toBe(600);
  });

  it('rolls the date and the weekday over at local midnight, not UTC midnight', () => {
    // 22:00Z on Wednesday is already 01:00 Thursday in Riyadh. A branch open
    // late is the case that meets this, which is the case that matters.
    const lateUtc = new Date('2026-01-07T22:00:00Z');
    const riyadh = localNowIn(lateUtc, 'Asia/Riyadh');
    expect(riyadh.date).toBe('2026-01-08');
    expect(riyadh.dayOfWeek).toBe(4);
    expect(riyadh.minuteOfDay).toBe(60);
  });

  it('reads local midnight as minute 0, never as 1440', () => {
    // `hour12: false` yields "24" for midnight in some ICU versions, which
    // would put every branch an entire day out of range.
    expect(localNowIn(new Date('2026-01-07T21:00:00Z'), 'Asia/Riyadh').minuteOfDay).toBe(0);
  });
});
