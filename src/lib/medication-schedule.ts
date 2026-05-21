export interface ScheduleRecurrence {
  daysOfWeek: number[];
  intervalWeeks: number;
}

/**
 * Minimal schedule shape consumed by `expandTodayIntakes`. Mirrors the
 * relevant subset of the Prisma `MedicationSchedule` row (`id`,
 * `windowStart`, `windowEnd`, `daysOfWeek`) plus the parent
 * `medicationId` so the projected slots carry enough context for the
 * intake-route caller to upsert into `MedicationIntakeEvent` without
 * re-joining.
 *
 * `daysOfWeek` is the encoded string per `serializeScheduleRecurrence`
 * (e.g. `null` for daily, `"1,3,5"` for Mon/Wed/Fri, `"i2;1"` for every
 * other Monday). The DB schema column documents `null = daily` as the
 * convention every reader honours.
 */
export interface TodayExpandableSchedule {
  id: string;
  medicationId: string;
  /** "HH:mm" 24h, user-tz reference. */
  windowStart: string;
  /** "HH:mm" 24h. May wrap midnight (`windowEnd < windowStart`). */
  windowEnd: string;
  /** Encoded recurrence string per `serializeScheduleRecurrence`. */
  daysOfWeek: string | null;
}

/**
 * One projected dose slot for "today" in the user's timezone. The
 * `scheduledFor` is the UTC instant that corresponds to the schedule's
 * `windowStart` applied to today's local-day boundary in `timeZone`.
 */
export interface TodayExpandedSlot {
  scheduleId: string;
  medicationId: string;
  scheduledFor: Date;
}

const ENCODED_PATTERN = /^i([1-4]);(.*)$/;

function normalizeDays(days: number[]): number[] {
  return [...new Set(days)]
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((a, b) => a - b);
}

export function parseScheduleRecurrence(
  value: string | null | undefined,
): ScheduleRecurrence {
  if (!value) {
    return { daysOfWeek: [], intervalWeeks: 1 };
  }

  const encoded = ENCODED_PATTERN.exec(value);
  if (encoded) {
    const intervalWeeks = Number(encoded[1]);
    const days = encoded[2]
      ? encoded[2]
          .split(",")
          .map((token) => Number(token))
          .filter((num) => Number.isFinite(num))
      : [];
    return {
      daysOfWeek: normalizeDays(days),
      intervalWeeks:
        intervalWeeks >= 1 && intervalWeeks <= 4 ? intervalWeeks : 1,
    };
  }

  // Legacy format: "1,2,3"
  const legacyDays = value
    .split(",")
    .map((token) => Number(token))
    .filter((num) => Number.isFinite(num));
  return { daysOfWeek: normalizeDays(legacyDays), intervalWeeks: 1 };
}

export function serializeScheduleRecurrence(
  recurrence: ScheduleRecurrence,
): string | null {
  const days = normalizeDays(recurrence.daysOfWeek);
  const intervalWeeks =
    recurrence.intervalWeeks >= 1 && recurrence.intervalWeeks <= 4
      ? recurrence.intervalWeeks
      : 1;

  if (intervalWeeks === 1 && days.length === 0) return null;
  if (intervalWeeks === 1) return days.join(",");
  return `i${intervalWeeks};${days.join(",")}`;
}

/**
 * Project the supplied schedules to the dose slots they would produce
 * for "today" in the user's timezone. Treats `daysOfWeek` of `null`,
 * `""`, or "no valid weekdays after normalization" as "every day" — the
 * documented DB convention (`prisma/schema.prisma` annotates the column
 * `null = daily`). Explicit weekday arrays (`"1,3,5"`) still filter as
 * before, so a Monday-only schedule emits nothing on a Sunday.
 *
 * Used by `/api/medications/intake?scope=today` to backfill placeholder
 * `MedicationIntakeEvent` rows for active medications whose reminder
 * window has not yet opened — without this projection the endpoint
 * returned `[]` for daily meds before the reminder worker entered the
 * RED phase, leaving the iOS Dashboard tile + the "Erfassen" sheet
 * empty for the whole morning.
 *
 * The function is pure (no DB access) so the test surface stays inside
 * this file. The route owns the upsert.
 */
export function expandTodayIntakes(
  schedules: TodayExpandableSchedule[],
  reference: Date,
  timeZone: string,
): TodayExpandedSlot[] {
  const slots: TodayExpandedSlot[] = [];
  const today = localDayParts(reference, timeZone);

  for (const schedule of schedules) {
    const recurrence = parseScheduleRecurrence(schedule.daysOfWeek);

    // Day-of-week filter. Empty array (the parsed shape for `null` /
    // `""` / "no valid weekdays") means "every day" — no filter.
    if (
      recurrence.daysOfWeek.length > 0 &&
      !recurrence.daysOfWeek.includes(today.weekday)
    ) {
      continue;
    }

    // Multi-week cadence isn't anchored without a medication start
    // date here, so `intervalWeeks > 1` is conservatively skipped from
    // the today projection. The reminder worker still mints those rows
    // when their window opens because it has the medication context;
    // those meds are GLP-1-style weeklies which the iOS today list
    // doesn't depend on as a primary surface.
    if (recurrence.intervalWeeks > 1) continue;

    const [h, m] = schedule.windowStart.split(":").map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) continue;

    const scheduledFor = instantAtLocalHm(today, h, m, timeZone);
    slots.push({
      scheduleId: schedule.id,
      medicationId: schedule.medicationId,
      scheduledFor,
    });
  }

  return slots;
}

interface LocalDayParts {
  year: number;
  month: number;
  day: number;
  weekday: number;
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function localDayParts(date: Date, timeZone: string): LocalDayParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    weekday: WEEKDAY_MAP[get("weekday")] ?? 0,
  };
}

function instantAtLocalHm(
  day: LocalDayParts,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  // Two-pass solver — first guess assumes wall-clock equals UTC, then
  // correct by the zone's offset at that approximate instant. Two
  // iterations suffice for every IANA zone (the second pass adjusts
  // across DST transitions).
  let guess = new Date(
    Date.UTC(day.year, day.month - 1, day.day, hour, minute, 0, 0),
  );
  for (let i = 0; i < 2; i++) {
    const offsetMin = tzOffsetMinutes(guess, timeZone);
    guess = new Date(
      Date.UTC(day.year, day.month - 1, day.day, hour, minute, 0, 0) -
        offsetMin * 60_000,
    );
  }
  return guess;
}

function tzOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  let hour = get("hour");
  if (hour === 24) hour = 0;
  const asIfUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second"),
  );
  return Math.round((asIfUtc - date.getTime()) / 60000);
}
