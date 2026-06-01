import { prisma } from "@/lib/db";
import { resolveProvider } from "@/lib/ai/provider";
import { apiSuccess } from "@/lib/api-response";
import type { DataPoint, DataSummary } from "@/lib/analytics/trends";
import { summarize } from "@/lib/analytics/trends";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import { isBpReadingInTarget } from "@/lib/analytics/bp-in-target";
import {
  classifyBMI,
  classifyBP,
  generateAlerts,
} from "@/lib/analytics/classifications";
import {
  pairByTimestamp,
  pearsonCorrelation,
  type PairedPoint,
} from "@/lib/analytics/correlations";
import {
  buildComplianceMedicationContext,
  calculateCompliance,
  lastNonSkippedTakenAt,
} from "@/lib/analytics/compliance";
import { getMedicationCategories } from "@/lib/medication-category";
import { apiHandler, requireAuth, type AuthContext } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { requireAssistantSurface } from "@/lib/feature-flags";
import { cached, caches, type ServerCache } from "@/lib/cache/server-cache";
import { buildComprehensiveAggregate } from "@/lib/insights/comprehensive-aggregator";
import {
  ensureUserMoodRollupsFresh,
  readMoodDayRollups,
} from "@/lib/rollups/mood-rollups";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  // v1.4.31 — comprehensive feeds the hero strip narration and the
  // recommendations grid that share the Coach gate.
  await requireAssistantSurface("coach");

  // v1.4.35 — read-through the analytics cache keyed on
  // (userId, "comprehensive"). The /insights page mount routinely
  // fans out to this endpoint alongside the Coach drawer + the
  // recommendations grid; the 60s TTL converts every duplicate
  // mount within the window to a Map lookup. Invalidation is handled
  // by `invalidateUserMeasurements` which already evicts every key
  // under the `${userId}|` prefix (see `lib/cache/invalidate.ts`).
  const body = await cached(
    caches.analytics as ServerCache<Awaited<
      ReturnType<typeof buildComprehensiveResponse>
    >>,
    `${user.id}|comprehensive`,
    () => buildComprehensiveResponse(user),
    annotate,
  );

  return apiSuccess(body);
});

type AuthedUser = AuthContext["user"];

/**
 * v1.4.35 — comprehensive insights response body, lifted out of the
 * route handler so `cached()` can wrap it. Replaces the previous
 * 100k-row-in-JS aggregation with SQL-side aggregates served by
 * `buildComprehensiveAggregate`. The medication-compliance block keeps
 * its bounded Prisma reads (medications + intake events) — the directive
 * called those out as already on the safe path. The byte-shape of the
 * returned envelope is unchanged from the legacy route.
 */
export async function buildComprehensiveResponse(user: AuthedUser) {
  const userId = user.id;
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  // Fetch user profile (height + DOB drive BMI + BP targets).
  const dbUser = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      heightCm: true,
      dateOfBirth: true,
    },
  });

  // ── Aggregate-first reads ─────────────────────────────────
  // SQL-side rollup replaces the 100k-row findMany on the legacy
  // route. Returns per-type DataSummary identical to the JS
  // `summarize()` semantics over the 90-day window, plus the bounded
  // raw rows the BP target adherence pairing needs, plus daily-mean
  // buckets for the correlation pairings.
  const aggregate = await buildComprehensiveAggregate(userId);

  // v1.4.40 — swap the 90-day unbounded `prisma.moodEntry.findMany`
  // for the persistent mood-rollup DAY tier (audit Critical Finding
  // #2). The two consumers downstream — `dailyMoodEntries` for the
  // mood × metric correlations and `moodSummary` for the dashboard
  // mood block — read at a per-day resolution, which is precisely the
  // shape the rollup writer emits.
  //
  // Coverage-fallback: when the user has mood entries but zero rollup
  // rows yet (legacy account before the boot-time backfill has caught
  // up), fall back to a bounded 90-day raw walk once and fire the
  // warm-up so the next request lands on the rollup tier. Same posture
  // as `/api/mood/analytics`.
  //
  // The bucket key shape change is documented in the route-parity test
  // for `/api/mood/analytics`: rollup `bucketStart` is UTC-anchored
  // YYYY-MM-DD; the legacy `MoodEntry.date` column is TZ-anchored
  // (write-time). For Berlin tenants whose mood log timestamps don't
  // straddle the UTC boundary the two labels agree on every realistic
  // entry — the v1.5 per-user-tz bucketing closes the residual DST
  // edge.
  void ensureUserMoodRollupsFresh(userId);
  const moodRollupDayRows = await readMoodDayRollups(userId, ninetyDaysAgo);
  let dailyMoodEntries: Array<{ day: string; value: number }>;
  let moodDataPoints: DataPoint[];
  let moodEntryCount: number;
  if (moodRollupDayRows.length > 0) {
    dailyMoodEntries = moodRollupDayRows.map((r) => ({
      day: r.bucketStart.toISOString().slice(0, 10),
      value: Math.round(r.mean * 100) / 100,
    }));
    moodDataPoints = moodRollupDayRows.map((r) => ({
      date: r.bucketStart,
      value: r.mean,
    }));
    moodEntryCount = moodRollupDayRows.reduce((s, r) => s + r.count, 0);
  } else {
    // Coverage-fallback: legacy account with mood entries but no
    // rollup coverage yet. Bounded by the 90-day window so the walk is
    // capped even when the rollup miss happens.
    const moodEntries = await prisma.moodEntry.findMany({
      // v1.7.0 sync — exclude tombstoned rows.
      where: { userId, deletedAt: null, moodLoggedAt: { gte: ninetyDaysAgo } },
      orderBy: { moodLoggedAt: "asc" },
      select: { date: true, score: true, moodLoggedAt: true },
    });
    const moodByDay = new Map<string, { sum: number; count: number }>();
    for (const entry of moodEntries) {
      const current = moodByDay.get(entry.date) ?? { sum: 0, count: 0 };
      current.sum += entry.score;
      current.count += 1;
      moodByDay.set(entry.date, current);
    }
    dailyMoodEntries = Array.from(moodByDay.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, stats]) => ({
        day,
        value: Math.round((stats.sum / stats.count) * 100) / 100,
      }));
    // Feed per-day means into `summarize()` so the live-fallback path
    // shares the rollup-tier semantic (one DataPoint per day, the
    // daily mean) — mirrors the v1.4.39 mood/analytics QA UX-H1 fix.
    moodDataPoints = dailyMoodEntries.map((e) => ({
      date: new Date(`${e.day}T12:00:00.000Z`),
      value: e.value,
    }));
    moodEntryCount = moodEntries.length;
  }

  const moodSummary =
    moodDataPoints.length > 0 ? summarize(moodDataPoints) : null;

  const summaries: Record<string, DataSummary> = aggregate.summaries;

  // ── BMI ──────────────────────────────────────────────────
  let bmi: number | null = null;
  let bmiClassification = null;
  if (dbUser?.heightCm && summaries.WEIGHT?.latest) {
    const heightM = dbUser.heightCm / 100;
    bmi = Math.round((summaries.WEIGHT.latest / (heightM * heightM)) * 10) / 10;
    bmiClassification = classifyBMI(bmi);
  }

  // ── BP classification (30-day average) ────────────────────
  let bpClassification = null;
  const bpTargets = getBpTargets(dbUser?.dateOfBirth ?? null);
  if (
    summaries.BLOOD_PRESSURE_SYS?.avg30 &&
    summaries.BLOOD_PRESSURE_DIA?.avg30
  ) {
    bpClassification = classifyBP(
      summaries.BLOOD_PRESSURE_SYS.avg30,
      summaries.BLOOD_PRESSURE_DIA.avg30,
    );
  }

  // ── BP target adherence ──────────────────────────────────
  // Keeps the 5-minute tolerance contract — sys + dia must pair on
  // the same reading session. The aggregator pulled the bounded raw
  // rows; we reuse `pairByTimestamp` against them so the output is
  // byte-identical to the legacy path.
  let bpPctInTarget: number | null = null;
  if (bpTargets) {
    const sysData: DataPoint[] = aggregate.bpRawRows.sys.map((r) => ({
      date: r.measuredAt,
      value: r.value,
    }));
    const diaData: DataPoint[] = aggregate.bpRawRows.dia.map((r) => ({
      date: r.measuredAt,
      value: r.value,
    }));
    const sysPairs = pairByTimestamp(sysData, diaData, 5 * 60 * 1000);

    if (sysPairs.length > 0) {
      // v1.4.16 A2 — one-sided ceiling semantics with hypotension
      // floor. See lib/analytics/bp-in-target.ts.
      const inTarget = sysPairs.filter((p) =>
        isBpReadingInTarget(p.a, p.b, bpTargets),
      ).length;
      bpPctInTarget = Math.round((inTarget / sysPairs.length) * 100);
    }
  }

  // ── Correlations: weight × Sys BP ─────────────────────────
  // Daily-key pairing (the legacy `pairByTimestamp` ran with a
  // 24-hour default tolerance — daily-mean buckets are the
  // SQL-side equivalent and the directive explicitly accepts the
  // small semantic shift to bound the raw-row footprint).
  const weightDaily = aggregate.dailyByType.WEIGHT ?? [];
  const sysDaily = aggregate.dailyByType.BLOOD_PRESSURE_SYS ?? [];
  const weightBpPairs: PairedPoint[] = joinDailyByDay(
    weightDaily,
    sysDaily,
  );
  const weightBpCorrelation = pearsonCorrelation(weightBpPairs);
  const scatterData = weightBpPairs.map((p) => ({
    weight: p.a,
    sysBP: p.b,
  }));

  // ── Correlations: mood × {sys BP, weight, pulse} ─────────
  // Daily-key matches the legacy `buildMoodMetricPairs` exactly —
  // mood is already per-day in the legacy code and we just align the
  // metric side to the same daily bucket.
  const moodBpPairs = pairMoodWithDaily(dailyMoodEntries, sysDaily);
  const moodBpCorrelation = pearsonCorrelation(moodBpPairs);
  const moodBpScatterData = moodBpPairs.map((p) => ({ mood: p.a, sysBP: p.b }));

  const moodWeightPairs = pairMoodWithDaily(dailyMoodEntries, weightDaily);
  const moodWeightCorrelation = pearsonCorrelation(moodWeightPairs);
  const moodWeightScatterData = moodWeightPairs.map((p) => ({
    mood: p.a,
    weight: p.b,
  }));

  const pulseDaily = aggregate.dailyByType.PULSE ?? [];
  const moodPulsePairs = pairMoodWithDaily(dailyMoodEntries, pulseDaily);
  const moodPulseCorrelation = pearsonCorrelation(moodPulsePairs);
  const moodPulseScatterData = moodPulsePairs.map((p) => ({
    mood: p.a,
    pulse: p.b,
  }));

  // ── Medication compliance ────────────────────────────────
  // Bounded reads — left untouched per the directive.
  const medications = await prisma.medication.findMany({
    where: { userId, active: true },
    include: { schedules: true },
  });
  const categoryMap = await getMedicationCategories(
    medications.map((m) => m.id),
  );

  const medCompliance = [];
  const bpMedicationEvents: Array<{
    scheduledFor: Date;
    takenAt: Date | null;
    skipped: boolean;
  }> = [];
  const bpMedications = medications.filter(
    (med) => (categoryMap[med.id] ?? "OTHER") === "BLOOD_PRESSURE",
  );
  // Single round-trip for all medications instead of N+1: one query keyed
  // on `medicationId IN (...)`, then group in memory.
  const allEvents = medications.length
    ? await prisma.medicationIntakeEvent.findMany({
        where: {
          medicationId: { in: medications.map((m) => m.id) },
          userId,
          // v1.7.0 sync — exclude tombstoned rows.
          deletedAt: null,
          scheduledFor: { gte: ninetyDaysAgo },
        },
        orderBy: { scheduledFor: "desc" },
      })
    : [];

  const eventsByMed = new Map<string, typeof allEvents>();
  for (const ev of allEvents) {
    const list = eventsByMed.get(ev.medicationId);
    if (list) list.push(ev);
    else eventsByMed.set(ev.medicationId, [ev]);
  }

  for (const med of medications) {
    const events = eventsByMed.get(med.id) ?? [];
    const mapped = events.map((e) => ({
      takenAt: e.takenAt,
      skipped: e.skipped,
      scheduledFor: e.scheduledFor,
    }));
    // v1.7.0 SB-SCHED-2 — engine-routed denominator.
    const medicationContext = buildComplianceMedicationContext(
      med,
      lastNonSkippedTakenAt(mapped),
      user.timezone || "Europe/Berlin",
    );
    const c7 = calculateCompliance(mapped, med.schedules, 7, med.createdAt, {
      medicationContext,
    });
    const c30 = calculateCompliance(mapped, med.schedules, 30, med.createdAt, {
      medicationContext,
    });

    medCompliance.push({
      id: med.id,
      name: med.name,
      dose: med.dose,
      category: categoryMap[med.id] ?? "OTHER",
      compliance7: c7.rate,
      compliance30: c30.rate,
      streak: c7.streak,
      taken7: c7.taken,
      skipped7: c7.skipped,
      missed7: c7.missed,
    });

    if ((categoryMap[med.id] ?? "OTHER") === "BLOOD_PRESSURE") {
      bpMedicationEvents.push(
        ...events.map((e) => ({
          scheduledFor: e.scheduledFor,
          takenAt: e.takenAt,
          skipped: e.skipped,
        })),
      );
    }
  }

  // ── Correlation: BP medication continuity × systolic BP ──
  // Uses the same daily BP_SYS series the aggregator pre-computed —
  // no second round-trip. The intake-side aggregation matches the
  // legacy code: continuity = min(1, taken / expectedPerDay), pairing
  // every day that had a sys reading.
  let bpMedicationCorrelation: {
    r: number;
    strength: string;
    n: number;
    medicationCount: number;
  } | null = null;
  const bpMedicationScatterData: Array<{
    continuityPct: number;
    sysBP: number;
  }> = [];

  const expectedBpIntakesPerDay = bpMedications.reduce(
    (sum, med) => sum + med.schedules.length,
    0,
  );

  if (expectedBpIntakesPerDay > 0) {
    // Daily systolic means (already keyed YYYY-MM-DD) from the SQL pass.
    const sysByDay = new Map<string, number>();
    for (const row of sysDaily) {
      sysByDay.set(row.day, row.value);
    }

    const takenByDay = new Map<string, number>();
    for (const event of bpMedicationEvents) {
      if (event.skipped || !event.takenAt) continue;
      const dayKey = event.scheduledFor.toISOString().slice(0, 10);
      takenByDay.set(dayKey, (takenByDay.get(dayKey) ?? 0) + 1);
    }

    const pairs: Array<{ a: number; b: number; date: Date }> = [];
    for (const [dayKey, avgSys] of sysByDay.entries()) {
      const taken = takenByDay.get(dayKey) ?? 0;
      const continuity = Math.min(1, taken / expectedBpIntakesPerDay);
      pairs.push({
        a: continuity,
        b: avgSys,
        date: new Date(`${dayKey}T00:00:00.000Z`),
      });
      bpMedicationScatterData.push({
        continuityPct: Math.round(continuity * 100),
        sysBP: Math.round(avgSys * 10) / 10,
      });
    }

    const corr = pearsonCorrelation(pairs);
    if (corr) {
      bpMedicationCorrelation = {
        ...corr,
        medicationCount: bpMedications.length,
      };
    }
  }

  // Generate alerts
  const alerts = generateAlerts({
    bmi,
    bpAvgSys: summaries.BLOOD_PRESSURE_SYS?.avg30 ?? null,
    bpAvgDia: summaries.BLOOD_PRESSURE_DIA?.avg30 ?? null,
    bpPctInTarget,
    weightSlope30: summaries.WEIGHT?.slope30?.slope ?? null,
    pulseAvg30: summaries.PULSE?.avg30 ?? null,
    pulseAnomalyCount: summaries.PULSE?.anomalyCount,
    medications: medCompliance.map((m) => ({
      name: m.name,
      compliance7: m.compliance7,
      compliance30: m.compliance30,
    })),
  });

  // Data span — derived from the earliest 90-day measurement.
  const dataSpanDays = aggregate.firstMeasurementAt
    ? Math.ceil(
        (Date.now() - aggregate.firstMeasurementAt.getTime()) /
          (24 * 60 * 60 * 1000),
      )
    : 0;

  annotate({
    action: { name: "insights.comprehensive" },
    meta: {
      totalMeasurements: aggregate.totalMeasurements,
      moodEntries: moodEntryCount,
      medications: medications.length,
    },
  });

  return {
    summaries,
    bmi,
    bmiClassification,
    bpClassification,
    bpPctInTarget,
    bpTargets,
    weightBpCorrelation,
    scatterData,
    bpMedicationCorrelation,
    bpMedicationScatterData,
    moodSummary,
    moodBpCorrelation,
    moodBpScatterData,
    moodWeightCorrelation,
    moodWeightScatterData,
    moodPulseCorrelation,
    moodPulseScatterData,
    medications: medCompliance,
    alerts,
    hasProvider: (await resolveProvider(userId)).type !== "none",
    dataSpanDays,
    totalMeasurements: aggregate.totalMeasurements,
  };
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Daily-key inner join between two daily-aggregated series. Returns
 * `PairedPoint` shapes compatible with `pearsonCorrelation`.
 *
 * Inputs are sorted ASC by `day` (the aggregator's ORDER BY
 * guarantees that). The walk is O(n + m) merge-join style instead of
 * Map.lookup-per-element so it scales with the worst-case 90 buckets
 * x 90 buckets case without surprises.
 */
function joinDailyByDay(
  a: Array<{ day: string; value: number }>,
  b: Array<{ day: string; value: number }>,
): PairedPoint[] {
  const pairs: PairedPoint[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ai = a[i];
    const bj = b[j];
    if (ai.day === bj.day) {
      pairs.push({
        a: ai.value,
        b: bj.value,
        date: new Date(`${ai.day}T12:00:00.000Z`),
      });
      i += 1;
      j += 1;
    } else if (ai.day < bj.day) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/**
 * Pair the daily mood series (left side) with a daily-aggregated
 * metric (right side). Matches the legacy `buildMoodMetricPairs`
 * helper byte-for-byte: same daily YYYY-MM-DD key, same
 * `T12:00:00.000Z` anchor for the `date` field.
 */
function pairMoodWithDaily(
  dailyMood: Array<{ day: string; value: number }>,
  dailyMetric: Array<{ day: string; value: number }>,
): PairedPoint[] {
  if (dailyMood.length === 0 || dailyMetric.length === 0) return [];
  const metricByDay = new Map<string, number>();
  for (const m of dailyMetric) {
    metricByDay.set(m.day, m.value);
  }
  const pairs: PairedPoint[] = [];
  for (const mood of dailyMood) {
    const metric = metricByDay.get(mood.day);
    if (metric !== undefined) {
      pairs.push({
        a: mood.value,
        b: metric,
        date: new Date(`${mood.day}T12:00:00.000Z`),
      });
    }
  }
  return pairs;
}
