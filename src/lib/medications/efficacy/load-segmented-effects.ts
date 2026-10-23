/**
 * The database half of the segmented medication effect: one intake-event
 * read, one confounder read and one per-day SQL fold per target, handed to the
 * pure assembly in `./segmented-effect.ts`.
 */
import type { MeasurementType, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import {
  buildComplianceMedicationContext,
  buildMedicationComplianceBundle,
  COURSES_COMPLIANCE_SELECT,
  dailyComplianceRatesFromLedger,
  lastNonSkippedTakenAt,
} from "@/lib/analytics/compliance";
import { dueSchedules } from "@/lib/medications/intake-tracking";
import { dayKeyOfDate } from "@/lib/medications/course-window";
import { readDayAggregates } from "@/lib/measurements/day-aggregates";
import { plausibleMetricRange } from "@/lib/measurements/value-domain";
import { userDayKey } from "@/lib/tz/format";
import { dayKeyAsUtcMidnight } from "@/lib/tz/date-only";
import {
  buildSegmentedEffect,
  notTakingPredicate,
  SEGMENTED_POST_WINDOW_DAYS,
  SEGMENTED_PRE_WINDOW_DAYS,
  type EfficacyConfounder,
  type EfficacySegmented,
  type SegmentedEffectInput,
} from "./segmented-effect";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The medication shape the effect needs: the efficacy builder's include. */
export const EFFECT_MEDICATION_INCLUDE = {
  schedules: true,
  scheduleRevisions: { orderBy: { validFrom: "asc" } },
  pauseEras: { select: { pausedAt: true, resumedAt: true } },
  courses: COURSES_COMPLIANCE_SELECT,
  doseChanges: { orderBy: { effectiveFrom: "asc" } },
} satisfies Prisma.MedicationInclude;

export type EffectMedication = Prisma.MedicationGetPayload<{
  include: typeof EFFECT_MEDICATION_INCLUDE;
}>;

/** Other medications' starts, stops, dose changes and pauses inside a window. */
async function loadConfounders(
  userId: string,
  medicationId: string,
  windowFrom: Date,
  windowTo: Date,
  timezone: string,
): Promise<EfficacyConfounder[]> {
  const inWindow = { gte: windowFrom, lte: windowTo };
  const others = await prisma.medication.findMany({
    where: {
      userId,
      id: { not: medicationId },
      OR: [
        { startsOn: inWindow },
        { endsOn: inWindow },
        { doseChanges: { some: { effectiveFrom: inWindow } } },
        { pauseEras: { some: { pausedAt: inWindow } } },
        { pauseEras: { some: { resumedAt: inWindow } } },
      ],
    },
    select: {
      name: true,
      startsOn: true,
      endsOn: true,
      doseChanges: {
        where: { effectiveFrom: inWindow },
        select: { effectiveFrom: true },
      },
      pauseEras: { select: { pausedAt: true, resumedAt: true } },
    },
    take: 50,
  });
  const out: EfficacyConfounder[] = [];
  const within = (d: Date | null): d is Date =>
    d !== null &&
    d.getTime() >= windowFrom.getTime() &&
    d.getTime() <= windowTo.getTime();
  for (const m of others) {
    if (within(m.startsOn)) {
      out.push({
        medicationName: m.name,
        event: "started",
        date: dayKeyOfDate(m.startsOn),
      });
    }
    if (within(m.endsOn)) {
      out.push({
        medicationName: m.name,
        event: "stopped",
        date: dayKeyOfDate(m.endsOn),
      });
    }
    for (const dc of m.doseChanges) {
      out.push({
        medicationName: m.name,
        event: "dose_change",
        date: userDayKey(dc.effectiveFrom, timezone),
      });
    }
    for (const p of m.pauseEras) {
      if (within(p.pausedAt)) {
        out.push({
          medicationName: m.name,
          event: "paused",
          date: userDayKey(p.pausedAt, timezone),
        });
      }
      if (within(p.resumedAt)) {
        out.push({
          medicationName: m.name,
          event: "resumed",
          date: userDayKey(p.resumedAt, timezone),
        });
      }
    }
  }
  return out;
}

/**
 * Load and fit the segmented effect for each metric target of one medication.
 * `now` bounds every read: a report pinned in the past passes its own end so
 * nothing after it is used. Reads: one intake-event query, one confounder
 * query, and one per-day SQL fold per target.
 */
export async function loadSegmentedEffects(params: {
  userId: string;
  med: EffectMedication;
  targets: readonly MeasurementType[];
  timezone: string;
  now: Date;
}): Promise<Map<MeasurementType, EfficacySegmented>> {
  const { userId, med, targets, timezone, now } = params;
  const out = new Map<MeasurementType, EfficacySegmented>();
  if (targets.length === 0) return out;

  const pivotDay = med.startsOn ? dayKeyOfDate(med.startsOn) : null;
  const lastDay = userDayKey(now, timezone);
  if (pivotDay === null || pivotDay > lastDay) {
    const empty = buildSegmentedEffect({
      dayValues: [],
      pivotDay: null,
      lastDay,
      adherenceDays: null,
      notTakingOn: () => false,
      ownDoseChangeDays: [],
      otherMedicationEvents: [],
    });
    for (const t of targets) out.set(t, empty);
    return out;
  }

  // A day of margin either side: the SQL folds on local days, the window is
  // cut on day keys afterwards.
  const pivotMs = dayKeyAsUtcMidnight(pivotDay).getTime();
  const since = new Date(pivotMs - (SEGMENTED_PRE_WINDOW_DAYS + 1) * DAY_MS);
  const until = new Date(
    Math.min(
      now.getTime(),
      pivotMs + (SEGMENTED_POST_WINDOW_DAYS + 1) * DAY_MS,
    ),
  );

  let adherenceDays: SegmentedEffectInput["adherenceDays"] = null;
  if (med.trackIntake) {
    const events = await prisma.medicationIntakeEvent.findMany({
      where: {
        medicationId: med.id,
        userId,
        deletedAt: null,
        scheduledFor: { gte: since, lte: until },
      },
      orderBy: [{ scheduledFor: "desc" }, { id: "desc" }],
      select: {
        takenAt: true,
        skipped: true,
        scheduledFor: true,
        autoMissed: true,
        attributionSource: true,
      },
    });
    const ctx = buildComplianceMedicationContext(
      med,
      lastNonSkippedTakenAt(events),
      timezone,
    );
    const bundle = buildMedicationComplianceBundle(
      events,
      dueSchedules(med),
      ctx,
      until,
    );
    adherenceDays = dailyComplianceRatesFromLedger(
      bundle.ledgerRows,
      timezone,
    ).map((d) => ({
      day: userDayKey(d.date, timezone),
      taken: d.taken,
      missed: d.missed,
    }));
  }

  const confounders = await loadConfounders(
    userId,
    med.id,
    since,
    until,
    timezone,
  );
  const notTakingOn = notTakingPredicate(med, timezone);
  const ownDoseChangeDays = med.doseChanges.map((dc) =>
    userDayKey(dc.effectiveFrom, timezone),
  );

  for (const target of targets) {
    const rows = await readDayAggregates({
      userId,
      type: target,
      since,
      until,
      timeZone: timezone,
      valueRange: plausibleMetricRange(target),
    });
    out.set(
      target,
      buildSegmentedEffect({
        dayValues: rows.map((r) => ({
          day: r.day,
          value: r.dayMean ?? r.sum / r.n,
        })),
        pivotDay,
        lastDay,
        adherenceDays,
        notTakingOn,
        ownDoseChangeDays,
        otherMedicationEvents: confounders,
      }),
    );
  }
  return out;
}
