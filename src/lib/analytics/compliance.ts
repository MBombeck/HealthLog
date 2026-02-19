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

export interface ComplianceResult {
  totalExpected: number;
  taken: number;
  skipped: number;
  missed: number;
  rate: number; // 0-100
  streak: number; // consecutive days with all taken
}

/**
 * Calculate compliance for a medication over a given period.
 */
export function calculateCompliance(
  events: IntakeEvent[],
  schedules: ScheduleWindow[],
  days: number,
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

  // Expected doses = schedules per day * days
  const totalExpected = schedules.length * days;

  // Filter events in period
  const periodEvents = events.filter(
    (e) => e.scheduledFor >= periodStart && e.scheduledFor <= now,
  );

  const taken = periodEvents.filter(
    (e) => e.takenAt !== null && !e.skipped,
  ).length;
  const skipped = periodEvents.filter((e) => e.skipped).length;
  const missed = Math.max(0, totalExpected - taken - skipped);

  const rate =
    totalExpected > 0 ? Math.round((taken / totalExpected) * 100) : 100;

  // Calculate streak: consecutive days with all scheduled intakes taken
  let streak = 0;
  for (let d = 0; d < days; d++) {
    const dayStart = new Date(now.getTime() - (d + 1) * 24 * 60 * 60 * 1000);
    const dayEnd = new Date(now.getTime() - d * 24 * 60 * 60 * 1000);

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
