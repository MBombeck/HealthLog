/**
 * Medication compliance calculations.
 */

interface IntakeEvent {
  takenAt: Date | null;
  skipped: boolean;
  scheduledFor: Date;
}

interface ScheduleWindow {
  windowStart: string; // HH:mm
  windowEnd: string; // HH:mm
}

export type IntakeTimingClass = "on_time" | "late" | "very_late" | "missed";

export interface ComplianceResult {
  totalExpected: number;
  taken: number;
  skipped: number;
  missed: number;
  rate: number; // 0-100
  streak: number; // consecutive days with all taken
}

/** Daily compliance data including timing breakdown. */
export interface DailyComplianceEntry {
  expected: number;
  taken: number;
  skipped: number;
  onTime: number;
  late: number;
  veryLate: number;
}

/**
 * Parse "HH:mm" into hours and minutes.
 */
function parseHHmm(time: string): { hours: number; minutes: number } {
  const [h, m] = time.split(":").map(Number);
  return { hours: h, minutes: m };
}

/**
 * Build a Date for a given "HH:mm" on a specific date.
 */
function toDateOnDay(time: string, day: Date): Date {
  const { hours, minutes } = parseHHmm(time);
  const d = new Date(day);
  d.setUTCHours(hours, minutes, 0, 0);
  return d;
}

/**
 * Classify how punctual an intake was relative to a schedule window.
 *
 * - "on_time":   within windowStart-1h .. windowEnd (1h early grace)
 * - "late":      within windowEnd .. windowEnd+2h
 * - "very_late": after windowEnd+2h
 * - "missed":    takenAt is null
 *
 * Handles overnight windows (windowEnd < windowStart means next day).
 */
export function classifyIntakeTiming(
  takenAt: Date | null,
  windowStart: string, // "HH:mm"
  windowEnd: string, // "HH:mm"
  scheduledDate: Date, // the date this was scheduled
  options?: { lateMinutes?: number },
): IntakeTimingClass {
  if (takenAt === null) return "missed";

  const start = toDateOnDay(windowStart, scheduledDate);
  let end = toDateOnDay(windowEnd, scheduledDate);

  // Handle overnight windows (e.g. windowStart="23:00", windowEnd="01:00")
  if (end <= start) {
    end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  }

  // 1h grace period before windowStart
  const graceStart = new Date(start.getTime() - 60 * 60 * 1000);
  // Configurable tolerance after windowEnd (default 120 min)
  const lateTolerance = (options?.lateMinutes ?? 120) * 60 * 1000;
  const lateEnd = new Date(end.getTime() + lateTolerance);

  const t = takenAt.getTime();

  if (t >= graceStart.getTime() && t <= end.getTime()) return "on_time";
  if (t > end.getTime() && t <= lateEnd.getTime()) return "late";
  return "very_late";
}

/**
 * Calculate compliance for a medication over a given period.
 * If medicationCreatedAt is provided, days before creation are excluded
 * so they don't count as "missed".
 */
export function calculateCompliance(
  events: IntakeEvent[],
  schedules: ScheduleWindow[],
  days: number,
  medicationCreatedAt?: Date,
): ComplianceResult {
  if (schedules.length === 0) {
    return {
      totalExpected: 0,
      taken: 0,
      skipped: 0,
      missed: 0,
      rate: 100,
      streak: 0,
    };
  }

  const now = new Date();
  const periodStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  // Don't count days before the medication existed
  const effectiveStart =
    medicationCreatedAt && medicationCreatedAt > periodStart
      ? medicationCreatedAt
      : periodStart;
  const effectiveDays = Math.max(
    1,
    Math.ceil(
      (now.getTime() - effectiveStart.getTime()) / (24 * 60 * 60 * 1000),
    ),
  );

  // Expected doses = schedules per day * effective days
  const totalExpected = schedules.length * effectiveDays;

  // Filter events in effective period
  const periodEvents = events.filter(
    (e) => e.scheduledFor >= effectiveStart && e.scheduledFor <= now,
  );

  const taken = periodEvents.filter(
    (e) => e.takenAt !== null && !e.skipped,
  ).length;
  const skipped = periodEvents.filter((e) => e.skipped).length;
  const missed = Math.max(0, totalExpected - taken - skipped);

  const rate =
    totalExpected > 0
      ? Math.min(100, Math.round((taken / totalExpected) * 100))
      : 100;

  // Calculate streak: consecutive days with all scheduled intakes taken
  let streak = 0;
  for (let d = 0; d < effectiveDays; d++) {
    const dayStart = new Date(now.getTime() - (d + 1) * 24 * 60 * 60 * 1000);
    const dayEnd = new Date(now.getTime() - d * 24 * 60 * 60 * 1000);

    // Skip days before medication creation
    if (medicationCreatedAt && dayEnd <= medicationCreatedAt) break;

    const dayEvents = periodEvents.filter(
      (e) => e.scheduledFor >= dayStart && e.scheduledFor < dayEnd,
    );
    const dayTaken = dayEvents.filter(
      (e) => e.takenAt !== null && !e.skipped,
    ).length;

    if (dayTaken >= schedules.length) {
      streak++;
    } else {
      break;
    }
  }

  return { totalExpected, taken, skipped, missed, rate, streak };
}
