/**
 * v1.4.37 W4b — shared current-window status helper for medication
 * detail cards.
 *
 * Both the generic `<MedicationCard>` (Ramipril etc.) and the GLP-1
 * variant (`<Glp1MedicationCard>` — Mounjaro etc.) need to paint the
 * same coloured "take now / overdue / very overdue" pill at the top of
 * their detail surface. The logic was historically inlined in the
 * generic card only, which produced the visible asymmetry Marc reported
 * during the v1.4.37 UX audit (audit item 11).
 *
 * Lifting the schedule-window math into one helper guarantees both card
 * variants stay byte-equivalent for the status row — same thresholds,
 * same in-window / late / very-late tiering, same overnight-window
 * handling, same "don't show in-window if last intake already covered
 * this window today" guard. The GLP-1 schedule shape carries the same
 * `windowStart` / `windowEnd` / `daysOfWeek` fields as the generic
 * schedule, so the helper accepts any schedule that satisfies the
 * minimal `ScheduleWindowInput` shape.
 */
import { parseScheduleRecurrence } from "@/lib/medication-schedule";

export interface ScheduleWindowInput {
  windowStart: string;
  windowEnd: string;
  daysOfWeek: string | null;
}

export type MedicationWindowStatus = "in_window" | "late" | "very_late" | null;

export interface CurrentWindowStatus<Schedule extends ScheduleWindowInput> {
  status: MedicationWindowStatus;
  schedule: Schedule | null;
}

/**
 * Convert a `Date` from its underlying UTC instant into the wall-clock
 * value in Europe/Berlin so the per-minute arithmetic below treats the
 * user's day boundary correctly. Intentionally en-US — this is not a
 * user-facing format string, only a parseable round-trip to shift the
 * value into Berlin local time.
 */
export function toBerlinDate(date: Date): Date {
  return new Date(date.toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
}

export function parseTimeToMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  if (
    !Number.isFinite(h) ||
    !Number.isFinite(m) ||
    h < 0 ||
    h > 23 ||
    m < 0 ||
    m > 59
  ) {
    return 0;
  }
  return h * 60 + m;
}

function getWindowStatus<Schedule extends ScheduleWindowInput>(
  schedule: Schedule,
  nowBerlin: Date,
  lateMinutes: number,
  missedMinutes: number,
): MedicationWindowStatus {
  const nowMins = nowBerlin.getHours() * 60 + nowBerlin.getMinutes();
  const startMins = parseTimeToMinutes(schedule.windowStart);
  let endMins = parseTimeToMinutes(schedule.windowEnd);

  // Handle overnight windows
  if (endMins <= startMins) endMins += 24 * 60;
  const adjustedNow =
    nowMins < startMins && endMins > 24 * 60 ? nowMins + 24 * 60 : nowMins;

  // Currently in window
  if (adjustedNow >= startMins && adjustedNow <= endMins) return "in_window";

  // Past window end: check late thresholds
  const minutesPastEnd = adjustedNow - endMins;
  if (minutesPastEnd > 0 && minutesPastEnd <= lateMinutes) return "late";
  if (minutesPastEnd > lateMinutes && minutesPastEnd <= missedMinutes)
    return "very_late";

  return null;
}

function isLastIntakeInCurrentWindow<Schedule extends ScheduleWindowInput>(
  lastTakenAt: string | null,
  schedule: Schedule,
  nowBerlin: Date,
): boolean {
  if (!lastTakenAt) return false;

  const intake = toBerlinDate(new Date(lastTakenAt));

  // Must be same calendar day
  if (
    intake.getFullYear() !== nowBerlin.getFullYear() ||
    intake.getMonth() !== nowBerlin.getMonth() ||
    intake.getDate() !== nowBerlin.getDate()
  ) {
    return false;
  }

  const intakeMins = intake.getHours() * 60 + intake.getMinutes();
  const startMins = parseTimeToMinutes(schedule.windowStart);
  let endMins = parseTimeToMinutes(schedule.windowEnd);

  // Handle overnight windows
  if (endMins <= startMins) endMins += 24 * 60;
  const adjustedIntake =
    intakeMins < startMins && endMins > 24 * 60
      ? intakeMins + 24 * 60
      : intakeMins;

  return adjustedIntake >= startMins && adjustedIntake <= endMins;
}

/**
 * Count how many of the supplied schedules are past their window today,
 * honouring the recurrence's allowed days-of-week. Used by both cards
 * to suppress "overdue" pills once the user has already covered every
 * passed schedule with intake events for the day.
 */
function countPassedSchedules<Schedule extends ScheduleWindowInput>(
  schedules: Schedule[],
  nowBerlin: Date,
): number {
  return schedules.filter((s) => {
    const recurrence = parseScheduleRecurrence(s.daysOfWeek);
    if (
      recurrence.daysOfWeek.length > 0 &&
      !recurrence.daysOfWeek.includes(nowBerlin.getDay())
    ) {
      return false;
    }
    const endMins = parseTimeToMinutes(s.windowEnd);
    const nowMins = nowBerlin.getHours() * 60 + nowBerlin.getMinutes();
    return nowMins > endMins;
  }).length;
}

/**
 * Reduce a list of schedules into the most actionable window status
 * for the card header pill. Returns `null` status when the medication
 * is paused, no schedule is currently in/past its window, or every
 * overdue schedule is already covered by today's intake events.
 *
 * Priority: in_window > late > very_late. Suppresses an `in_window`
 * status when the last intake already falls inside the window so the
 * pill doesn't nag after the user took the dose.
 */
export function reduceCurrentWindowStatus<Schedule extends ScheduleWindowInput>(
  options: {
    schedules: Schedule[];
    nowBerlin: Date;
    lateMinutes: number;
    missedMinutes: number;
    active: boolean;
    lastTakenAt: string | null;
    todayEventCount: number;
  },
): CurrentWindowStatus<Schedule> {
  const {
    schedules,
    nowBerlin,
    lateMinutes,
    missedMinutes,
    active,
    lastTakenAt,
    todayEventCount,
  } = options;

  if (!active) return { status: null, schedule: null };

  const passedScheduleCount = countPassedSchedules(schedules, nowBerlin);
  const hasUncoveredOverdue = todayEventCount < passedScheduleCount;

  return schedules.reduce<CurrentWindowStatus<Schedule>>(
    (best, s) => {
      const status = getWindowStatus(s, nowBerlin, lateMinutes, missedMinutes);
      if (!status) return best;
      // Don't show late/very_late if all overdue schedules are covered
      // by intake events for the day.
      if (status !== "in_window" && !hasUncoveredOverdue) return best;
      // Don't show in_window if last intake is already within this
      // window today.
      if (
        status === "in_window" &&
        isLastIntakeInCurrentWindow(lastTakenAt, s, nowBerlin)
      ) {
        return best;
      }
      const priority = { in_window: 3, late: 2, very_late: 1 };
      if (!best.status || priority[status] > priority[best.status]) {
        return { status, schedule: s };
      }
      return best;
    },
    { status: null, schedule: null },
  );
}
