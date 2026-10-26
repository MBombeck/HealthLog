/**
 * Per-day scheduled vs taken for the last N days:
 * `GET /api/medications/intake?scope=compliance`.
 *
 * Cached at a 15-minute TTL because daily compliance buckets are slow-moving
 * (intake events trickle in, yesterday's row doesn't move). The cache key
 * carries the userTz so a user who changes timezone doesn't read another
 * tz's bucketing.
 *
 * `scheduled` is the SCHEDULE-ANCHORED expected-dose count per day (the
 * canonical recurrence engine), NOT the count of logged intake rows. The old
 * rollup-backed path set `scheduled = COUNT(*)` of intake rows, so the
 * dashboard tile's rate (`taken / scheduled`) was ~100% across every window
 * regardless of real adherence — every logged row was both numerator and
 * denominator. Anchoring `scheduled` to the schedule makes the rate genuinely
 * reflect taken-of-expected and lets the 7/30/90 windows diverge with partial
 * adherence.
 */
import { annotate } from "@/lib/logging/context";
import { cached, caches, type ServerCache } from "@/lib/cache/server-cache";
import {
  buildScheduleAnchoredComplianceBuckets,
  type ScheduleAnchoredComplianceBucket,
} from "@/lib/analytics/schedule-anchored-compliance";

export async function readIntakeCompliance(input: {
  userId: string;
  days: number;
  userTz: string;
}): Promise<ScheduleAnchoredComplianceBucket[]> {
  const { userId, days, userTz } = input;
  const result = await cached(
    caches.medicationsIntake as ServerCache<ScheduleAnchoredComplianceBucket[]>,
    `${userId}|compliance|${days}|${userTz}`,
    () => buildScheduleAnchoredComplianceBuckets(userId, days, userTz),
    annotate,
  );

  annotate({
    action: { name: "medications.intake.compliance" },
    meta: { days, count: result.length },
  });

  return result;
}
