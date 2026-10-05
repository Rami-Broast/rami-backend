/**
 * Is the branch open, and if not, when does it open?
 *
 * The schedule itself has existed since the branch module was built —
 * timezone-aware, per-day, with date overrides for holidays and Ramadan — and
 * **nothing read it**. One staff endpoint answered "is this branch open" and no
 * client called it, no owner could set the hours (the admin panel had no
 * editor), and placement never consulted them. So a customer could order at
 * 03:00 and the branch found the ticket in the morning.
 *
 * This is that logic made pure, so the parts that are easy to get wrong — the
 * ones that are wrong only at 01:00, or only on one date a year — are testable
 * without a database, a clock or a branch.
 *
 * ## The rule that matters most
 *
 * **A branch with no schedule is unrestricted, not closed.** `isBranchOpen`
 * answers the narrow question ("is now inside configured hours") and returns
 * false when nothing is configured, which is truthful. Enforcement cannot use
 * that answer directly: every existing branch has an empty schedule, so
 * refusing orders on it would close the whole business the moment this shipped.
 * `configured: false` is therefore its own outcome, and the callers that
 * *refuse* things treat it as open. Making that distinction a returned field
 * rather than a caller's assumption is the point — the alternative is each
 * caller remembering, and one of them not.
 */

/** A weekly schedule row. Minutes from local midnight; `1380` is 23:00. */
export interface OpeningHoursEntry {
  /** 0 = Sunday … 6 = Saturday, in the branch's own timezone. */
  dayOfWeek: number;
  openMinute: number;
  closeMinute: number;
  isClosed?: boolean;
}

/** A date-specific override — a public holiday, Ramadan hours, a private event. */
export interface HoursOverride {
  /** `YYYY-MM-DD` in the branch's own timezone. */
  date: string;
  openMinute?: number | null;
  closeMinute?: number | null;
  isClosed: boolean;
  note?: string | null;
}

export type ClosedReason =
  /** Outside today's hours — it will open again. */
  | 'outside_hours'
  /** The weekly schedule marks this whole day closed. */
  | 'day_closed'
  /** A date override closes it — a holiday, usually with a note. */
  | 'override_closed';

export interface BranchOpenState {
  /**
   * Whether anyone has set a schedule at all.
   *
   * **False means unrestricted**, never "closed". See the module note: every
   * branch predating the editor has an empty schedule, and reading that as
   * closed would refuse every order on the platform.
   */
  configured: boolean;
  isOpen: boolean;
  /** Why it is shut. Null while open, and null when nothing is configured. */
  closedReason: ClosedReason | null;
  /** The override's own note ("Eid holiday"), when one is closing the branch. */
  note: string | null;
  /** Minutes-from-midnight the branch next opens, or null if not today. */
  opensAtMinute: number | null;
  /** Minutes-from-midnight the current open window ends. Null when shut. */
  closesAtMinute: number | null;
}

/** Local wall-clock facts about "now" at the branch. */
export interface LocalNow {
  /** `YYYY-MM-DD` in the branch's timezone. */
  date: string;
  /** 0 = Sunday … 6 = Saturday. */
  dayOfWeek: number;
  /** Minutes since local midnight. */
  minuteOfDay: number;
}

/**
 * The whole rule, as one pure function.
 *
 * Kept separate from the timezone conversion (`localNowIn`) so the arithmetic
 * can be tested with plain numbers and the conversion tested on its own — a
 * combined function is one where a timezone bug and an off-by-one look the
 * same in a failure.
 */
export function branchOpenState(
  hours: readonly OpeningHoursEntry[],
  overrides: readonly HoursOverride[],
  now: LocalNow,
): BranchOpenState {
  const override = overrides.find((o) => o.date === now.date);

  if (override) {
    // An override replaces the day outright — that is what makes it useful for
    // Eid and for Ramadan, where the weekly pattern simply does not apply.
    if (override.isClosed || override.openMinute == null || override.closeMinute == null) {
      return {
        configured: true,
        isOpen: false,
        closedReason: 'override_closed',
        note: override.note ?? null,
        opensAtMinute: null,
        closesAtMinute: null,
      };
    }
    const open = isMinuteInRange(now.minuteOfDay, override.openMinute, override.closeMinute);
    return {
      configured: true,
      isOpen: open,
      closedReason: open ? null : 'outside_hours',
      note: override.note ?? null,
      opensAtMinute: open ? null : override.openMinute,
      closesAtMinute: open ? override.closeMinute : null,
    };
  }

  if (hours.length === 0) {
    // Unrestricted. Not closed — see the module note.
    return {
      configured: false,
      isOpen: true,
      closedReason: null,
      note: null,
      opensAtMinute: null,
      closesAtMinute: null,
    };
  }

  const today = hours.filter((h) => h.dayOfWeek === now.dayOfWeek && !h.isClosed);

  // **Yesterday's late window still counts.** A shop open 18:00–02:00 on Friday
  // is open at 01:00 on Saturday, and that window lives on the *Friday* row.
  // Reading only today's rows reports it shut for the two hours a late-night
  // kitchen is busiest, and the branch would have had to know to add a phantom
  // Saturday 00:00–02:00 row to work around it.
  const yesterdayLate = hours.filter(
    (h) =>
      h.dayOfWeek === (now.dayOfWeek + 6) % 7 &&
      !h.isClosed &&
      h.closeMinute < h.openMinute &&
      now.minuteOfDay < h.closeMinute,
  );

  const openWindow =
    yesterdayLate[0] ??
    today.find((h) => isMinuteInRange(now.minuteOfDay, h.openMinute, h.closeMinute));

  if (openWindow) {
    return {
      configured: true,
      isOpen: true,
      closedReason: null,
      note: null,
      opensAtMinute: null,
      closesAtMinute: openWindow.closeMinute,
    };
  }

  // Shut. The next window today, if there is one — a split-shift branch that is
  // closed between lunch and dinner should say "opens at 17:00", not just
  // "closed", because those are different things to a hungry customer.
  const upcoming = today
    .filter((h) => h.openMinute > now.minuteOfDay)
    .sort((a, b) => a.openMinute - b.openMinute)[0];

  const dayIsClosed = today.length === 0;

  return {
    configured: true,
    isOpen: false,
    closedReason: dayIsClosed ? 'day_closed' : 'outside_hours',
    note: null,
    opensAtMinute: upcoming?.openMinute ?? null,
    closesAtMinute: null,
  };
}

/**
 * `true` when the branch may take an order.
 *
 * The one place the "unconfigured is unrestricted" rule is applied, so no
 * caller has to remember it.
 */
export function acceptsOrdersNow(state: BranchOpenState): boolean {
  return !state.configured || state.isOpen;
}

/** `540` → `"09:00"`. Minutes past 24h wrap, so a 02:00 close reads as 02:00. */
export function formatMinute(minute: number | null | undefined): string | null {
  if (minute === null || minute === undefined || !Number.isFinite(minute)) {
    return null;
  }
  const m = ((Math.trunc(minute) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * Whether a minute falls inside a window, including one that crosses midnight.
 *
 * `close <= open` means the window wraps — 18:00–02:00 is a real restaurant
 * shift, not a data-entry mistake.
 */
export function isMinuteInRange(current: number, open: number, close: number): boolean {
  if (open <= close) {
    return current >= open && current < close;
  }
  return current >= open || current < close;
}

/**
 * "Now", as the branch's own wall clock reads it.
 *
 * `Intl` does the conversion, so this is correct across DST without a timezone
 * database of our own. Saudi Arabia does not observe DST, but a branch's
 * timezone is a column and nothing stops it holding one that does.
 */
export function localNowIn(at: Date, timezone: string): LocalNow {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(at);

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '0';

  // `hour12: false` yields 24 rather than 00 for midnight in some ICU versions.
  const hour = Number(get('hour')) % 24;

  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    dayOfWeek: WEEKDAYS[get('weekday')] ?? 0,
    minuteOfDay: hour * 60 + Number(get('minute')),
  };
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};
