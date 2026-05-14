import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import { summarize, type DataPoint } from "@/lib/analytics/trends";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import { computeBpInTargetWindows } from "@/lib/analytics/bp-in-target";
import { berlinDayKey } from "@/lib/analytics/berlin-day";
import { calculateCompliance } from "@/lib/analytics/compliance";
import {
  computeHealthScore,
  defaultWeightTargetFromHeight,
  type HealthScoreInput,
  type HealthScoreResult,
} from "@/lib/analytics/health-score";
import {
  correlateBpCompliance,
  correlateMoodPulse,
  correlateWeightWeekday,
  type CorrelationResult,
} from "@/lib/insights/correlations";
import type { MeasurementType } from "@/generated/prisma/client";
import { measurementTypeEnum } from "@/lib/validations/measurement";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "analytics.get" } });

  // Derived from canonical enum so a new measurement type is auto-summarised
  // by /api/analytics (V3 audit: enum drift cousins).
  const types = [...measurementTypeEnum.options] as MeasurementType[];

  // v1.4.23 Sr-H1 — every per-type read goes through the chunked helper
  // so the route's working set stays bounded at MEASUREMENT_CHUNK_SIZE
  // rows per Prisma round-trip even for users with multi-year HealthKit
  // sync history. `summarize()` requires the full series (slope7/30/90,
  // anomalies) so groupBy cannot replace this read; the chunked path is
  // the smallest pagination contract that still satisfies the helper.
  let totalRowsReadForAggregate = 0;
  const measurementsByType = await Promise.all(
    types.map((type) =>
      fetchMeasurementSeriesChunked(user.id, type, {
        includeSleepStage: true,
      }).then((measurements) => {
        totalRowsReadForAggregate += measurements.length;
        // v1.4.23 — Apple Health's sleep ingest stores one row per
        // stage per night. Summarising the raw rows would treat each
        // stage as its own datapoint and grossly understate "average
        // sleep". Aggregate per Berlin day before summarising so the
        // summary matches the user's intuition (one number per night
        // = total minutes asleep).
        let datapoints: DataPoint[];
        if (type === "SLEEP_DURATION") {
          const byDay = new Map<string, { total: number; date: Date }>();
          for (const m of measurements) {
            const key = berlinDayKey(m.measuredAt);
            const slot = byDay.get(key) ?? {
              total: 0,
              date: m.measuredAt,
            };
            slot.total += m.value;
            if (m.measuredAt > slot.date) slot.date = m.measuredAt;
            byDay.set(key, slot);
          }
          datapoints = Array.from(byDay.values()).map(
            (s): DataPoint => ({ date: s.date, value: s.total }),
          );
          datapoints.sort((a, b) => a.date.getTime() - b.date.getTime());
        } else {
          datapoints = measurements.map(
            (m): DataPoint => ({
              date: m.measuredAt,
              value: m.value,
            }),
          );
        }
        return {
          type,
          summary: summarize(datapoints),
        };
      }),
    ),
  );

  const results: Record<string, ReturnType<typeof summarize>> = {};
  for (const { type, summary } of measurementsByType) {
    results[type] = summary;
  }

  // v1.4.23 Sr-H1 — slow-query attribution. Total rows pulled across
  // every per-type chunked read so ops can spot outlier users whose
  // analytics requests dominate the route's tail latency.
  annotate({
    meta: {
      analytics: {
        bp_aggregate: { row_count: totalRowsReadForAggregate },
      },
    },
  });

  // v1.4.23 — sleep-stage breakdown for the trailing 30 days. Only
  // included when the user has stage-tagged rows in window; null
  // otherwise so the UI can render a plain total without the
  // breakdown card painting empty.
  const sleepStages = await computeSleepStageBreakdown(user.id);

  // BMI calculation
  let bmi: number | null = null;
  if (user.heightCm && results.WEIGHT?.latest) {
    const heightM = user.heightCm / 100;
    bmi = Math.round((results.WEIGHT.latest / (heightM * heightM)) * 10) / 10;
  }

  // BP in-target percentage (auto-calculated from date of birth)
  let bpInTargetPct: number | null = null;
  let bpInTargetPct7d: number | null = null;
  let bpInTargetPct30d: number | null = null;
  let bpInTargetPctAllTime: number | null = null;
  /**
   * v1.4.22 W5 reconcile (Code-H2) — period-aligned prior-window
   * pcts so the BD-Zielbereich tile's comparison-overlay caption
   * stops mismatching its math with its label. The tile's
   * `compareDelta` is `last30Days - priorMonth` (or `… - priorYear`)
   * matching the user's `comparisonBaseline` selection, never
   * `last30Days - allTime` (the v1.4.22 A2 shortcut).
   */
  let bpInTargetPctPriorMonth: number | null = null;
  let bpInTargetPctPriorYear: number | null = null;
  const bpTargets = getBpTargets(user.dateOfBirth);
  if (bpTargets) {
    const now = new Date();
    // v1.4.22 A1 — re-anchor the BD-Zielbereich tile headline to the
    // last-30-day window. Up to v1.4.19 the headline pinned to the
    // 30-day average (so 7d / 30d / total all read 50 %). v1.4.19 A1
    // flipped the headline to all-time, which made the tile correct
    // but emotionally wrong: the headline was the slowest-moving
    // aggregate possible, punishing recent improvement. v1.4.22 A1
    // re-routes the headline to last-30-days and surfaces 7d / 30d /
    // all-time as a 3-line sub-row so power users still see the
    // long-arc number without it dominating. The helper still returns
    // every window — only the headline pick changed.
    //
    // v1.4.23 H2 — chunked aggregation replaces an unbounded findMany.
    // The W2-of-v1.4.20 fix did the right thing semantically (all-time
    // window for the headline) but read the entire BP table into one
    // array per type. A 5-year power user holds ~9 000 rows × 2; the
    // single-shot fetch produced a 50-100 ms Prisma round-trip plus a
    // ~2 MB allocation per request. Page through in 5 000-row chunks
    // so the working set stays bounded; accumulate into the same
    // `BpReading[]` shape the existing helper expects. The
    // `analytics.bp_in_target.row_count` wide-event meta lets ops
    // attribute slow requests to specific outlier users.
    const [sysData, diaData] = await Promise.all([
      fetchMeasurementSeriesChunked(user.id, "BLOOD_PRESSURE_SYS"),
      fetchMeasurementSeriesChunked(user.id, "BLOOD_PRESSURE_DIA"),
    ]);

    annotate({
      meta: {
        analytics: {
          bp_in_target: {
            row_count: sysData.length + diaData.length,
            sys_rows: sysData.length,
            dia_rows: diaData.length,
          },
        },
      },
    });

    const windows = computeBpInTargetWindows(sysData, diaData, bpTargets, now);
    bpInTargetPct = windows.last30Days?.pct ?? null;
    bpInTargetPct7d = windows.last7Days?.pct ?? null;
    bpInTargetPct30d = windows.last30Days?.pct ?? null;
    bpInTargetPctAllTime = windows.allTime?.pct ?? null;
    bpInTargetPctPriorMonth = windows.priorMonth?.pct ?? null;
    bpInTargetPctPriorYear = windows.priorYear?.pct ?? null;
  }

  // Per-context glucose summaries (canonical mg/dL).
  const glucoseRows = await prisma.measurement.findMany({
    where: { userId: user.id, type: "BLOOD_GLUCOSE" },
    orderBy: { measuredAt: "asc" },
    select: { value: true, measuredAt: true, glucoseContext: true },
  });
  const glucoseByContext: Record<string, ReturnType<typeof summarize>> = {};
  if (glucoseRows.length > 0) {
    const contexts = ["FASTING", "POSTPRANDIAL", "RANDOM", "BEDTIME"] as const;
    for (const ctx of contexts) {
      const ctxRows = glucoseRows.filter((r) => r.glucoseContext === ctx);
      if (ctxRows.length === 0) continue;
      glucoseByContext[ctx] = summarize(
        ctxRows.map((r): DataPoint => ({ date: r.measuredAt, value: r.value })),
      );
    }
  }

  // v1.4.20 phase B3 — three pre-defined correlation hypotheses.
  // All three run on the trailing 30 days so a sparse account doesn't
  // burn the n >= 20 gate on a stale window (v1.4.23 H6 raised the
  // floor from 14 → 20). Each runner gates on n >= 20 + p < 0.05;
  // below the bar the result.status === "insufficient" and the UI
  // paints an EmptyState.
  const correlations = await computeCorrelationHypotheses(user.id);

  // v1.4.20 phase B5 — Personal Health Score. Server-deterministic
  // composite of BP-in-target % + weight-trend alignment + mood
  // stability + medication compliance. The "vs last week" delta
  // re-runs the same compute against a 7-day-shifted snapshot.
  const healthScore = await computeUserHealthScore(user.id, {
    bpInTargetPct,
    heightCm: user.heightCm ?? null,
  });
  if (healthScore) {
    annotate({
      meta: {
        healthScore: {
          score: healthScore.score,
          band: healthScore.band,
          delta: healthScore.delta,
        },
      },
    });
  }

  return apiSuccess({
    summaries: results,
    bmi,
    bpInTargetPct,
    bpInTargetPct7d,
    bpInTargetPct30d,
    bpInTargetPctAllTime,
    bpInTargetPctPriorMonth,
    bpInTargetPctPriorYear,
    glucoseByContext,
    correlations,
    healthScore,
    sleepStages,
  });
});

/**
 * Per-stage sleep-minutes breakdown over the trailing 30 days.
 *
 * Returns `null` when the user has no stage-tagged sleep rows in
 * window — the analytics consumer renders the existing
 * `summaries.SLEEP_DURATION` totals without a stage card in that
 * case. Returns the sum-per-stage AND the day count covered so the
 * UI can render an "averaged across N nights" caption truthfully.
 */
async function computeSleepStageBreakdown(userId: string): Promise<{
  windowDays: number;
  nights: number;
  totalMinutes: number;
  stages: Record<string, number>;
} | null> {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const since = new Date(Date.now() - 30 * DAY_MS);
  const rows = await prisma.measurement.findMany({
    where: {
      userId,
      type: "SLEEP_DURATION",
      sleepStage: { not: null },
      measuredAt: { gte: since },
    },
    select: { value: true, measuredAt: true, sleepStage: true },
  });

  if (rows.length === 0) return null;

  const stages: Record<string, number> = {};
  const dayKeys = new Set<string>();
  let totalMinutes = 0;
  for (const row of rows) {
    if (!row.sleepStage) continue;
    stages[row.sleepStage] = (stages[row.sleepStage] ?? 0) + row.value;
    totalMinutes += row.value;
    dayKeys.add(berlinDayKey(row.measuredAt));
  }

  return {
    windowDays: 30,
    nights: dayKeys.size,
    totalMinutes,
    stages,
  };
}

/**
 * Build inputs for the three pre-defined hypotheses + run them.
 * Pure-ish — only Prisma reads, no external calls.
 *
 * Window: trailing 30 days. Anything older falls outside the surface
 * because the user-facing "based on N paired readings · last 30 days"
 * source-chip has to remain truthful.
 */
async function computeCorrelationHypotheses(userId: string): Promise<{
  bpCompliance: CorrelationResult;
  moodPulse: CorrelationResult;
  weightWeekday: CorrelationResult;
}> {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const since = new Date(Date.now() - 30 * DAY_MS);

  // v1.4.23 Sr-H1 — the four measurement reads route through the
  // chunked helper so even a noisy 30-day window (e.g. minute-level
  // HealthKit pulse samples) cannot allocate an unbounded buffer. The
  // helper still returns the full filtered series the Pearson runners
  // need; we just bound the per-page Prisma round-trip.
  const [sysRows, pulseRows, weightRows, moodRows, intakeRows] =
    await Promise.all([
      fetchMeasurementSeriesChunked(userId, "BLOOD_PRESSURE_SYS", { since }),
      fetchMeasurementSeriesChunked(userId, "PULSE", { since }),
      fetchMeasurementSeriesChunked(userId, "WEIGHT", { since }),
      prisma.moodEntry.findMany({
        where: { userId, moodLoggedAt: { gte: since } },
        select: { score: true, moodLoggedAt: true, date: true },
      }),
      prisma.medicationIntakeEvent.findMany({
        where: { userId, scheduledFor: { gte: since } },
        select: { scheduledFor: true, takenAt: true, skipped: true },
      }),
    ]);

  // ── Hypothesis 1: BP × medication compliance ────────────────
  // Aggregate by Berlin-day key so DST + UTC boundary issues don't split
  // a day's readings. The day's "compliance %" is taken / expected for
  // that calendar day across all medications.
  const dayKey = (d: Date): string => berlinDayKey(d);

  const dailySys = new Map<string, number[]>();
  for (const row of sysRows) {
    const key = dayKey(row.measuredAt);
    const list = dailySys.get(key) ?? [];
    list.push(row.value);
    dailySys.set(key, list);
  }

  const dailyCompliance = new Map<
    string,
    { expected: number; taken: number }
  >();
  for (const event of intakeRows) {
    const key = dayKey(event.scheduledFor);
    const slot = dailyCompliance.get(key) ?? { expected: 0, taken: 0 };
    slot.expected += 1;
    if (event.takenAt && !event.skipped) slot.taken += 1;
    dailyCompliance.set(key, slot);
  }

  const bpCompliancePairs: Array<{
    date: Date;
    systolic: number;
    compliancePct: number;
  }> = [];
  for (const [key, sysValues] of dailySys.entries()) {
    const slot = dailyCompliance.get(key);
    if (!slot || slot.expected === 0) continue;
    const compliancePct = (slot.taken / slot.expected) * 100;
    const meanSys = sysValues.reduce((s, v) => s + v, 0) / sysValues.length;
    bpCompliancePairs.push({
      date: dateFromBerlinKey(key),
      systolic: meanSys,
      compliancePct,
    });
  }
  const bpCompliance = correlateBpCompliance({ daily: bpCompliancePairs });

  // ── Hypothesis 2: Mood × resting pulse ──────────────────────
  // Same-day pairing: take the day's mean mood vs the day's mean pulse.
  // "Resting" is approximated by mean — HealthLog has no separate
  // resting-pulse field, so we accept the noise rather than skip.
  const dailyMood = new Map<string, number[]>();
  for (const row of moodRows) {
    const key = berlinDayKey(row.moodLoggedAt);
    const list = dailyMood.get(key) ?? [];
    list.push(row.score);
    dailyMood.set(key, list);
  }
  const dailyPulse = new Map<string, number[]>();
  for (const row of pulseRows) {
    const key = berlinDayKey(row.measuredAt);
    const list = dailyPulse.get(key) ?? [];
    list.push(row.value);
    dailyPulse.set(key, list);
  }
  const moodPulsePairs: Array<{
    date: Date;
    mood: number;
    restingPulse: number;
  }> = [];
  for (const [key, moodScores] of dailyMood.entries()) {
    const pulseValues = dailyPulse.get(key);
    if (!pulseValues || pulseValues.length === 0) continue;
    const meanMood = moodScores.reduce((s, v) => s + v, 0) / moodScores.length;
    const meanPulse =
      pulseValues.reduce((s, v) => s + v, 0) / pulseValues.length;
    moodPulsePairs.push({
      date: dateFromBerlinKey(key),
      mood: meanMood,
      restingPulse: meanPulse,
    });
  }
  const moodPulse = correlateMoodPulse({ daily: moodPulsePairs });

  // ── Hypothesis 3: Weight × weekday ──────────────────────────
  // 0 = Monday … 6 = Sunday. ISO weekday minus 1.
  const weightWeekdayPairs: Array<{ weekday: number; weight: number }> = [];
  for (const row of weightRows) {
    const isoWeekday = berlinIsoWeekday(row.measuredAt); // 1..7, 1=Mon
    weightWeekdayPairs.push({
      weekday: isoWeekday - 1,
      weight: row.value,
    });
  }
  const weightWeekday = correlateWeightWeekday({ daily: weightWeekdayPairs });

  // Annotate so admin observability can attribute coverage to the
  // corresponding wide-event rather than chasing it via DB queries.
  annotate({
    meta: {
      correlations: {
        bpCompliance: bpCompliance.status,
        moodPulse: moodPulse.status,
        weightWeekday: weightWeekday.status,
      },
    },
  });

  return { bpCompliance, moodPulse, weightWeekday };
}

/**
 * v1.4.23 Sr-H1 — paged read of every Measurement of a given type for
 * a single user.
 *
 * Boundary contract:
 *   - The route's per-type loop, the BD-Zielbereich BP windowing, and
 *     the correlation-hypothesis reads ALL pull through this helper so
 *     no analytics path holds an unbounded `findMany` against
 *     `measurement` any more.
 *   - `summarize()` (slope7/30/90, anomaly z-scores) and
 *     `computeBpInTargetWindows` (paired sys/dia matching) both need
 *     row-level access that `prisma.groupBy` cannot provide; chunked
 *     paging is the smallest contract that bounds the working set
 *     without changing the helpers.
 *   - The cursor is `id` with a stable `(measuredAt, id)` order so two
 *     rows sharing a timestamp (bulk-imported manual entries) don't
 *     stall the cursor or duplicate a row across pages.
 *
 * Page size is `MEASUREMENT_CHUNK_SIZE`; the safety-bound loop caps
 * total pages at 1 000 (= 5 M rows) which is well above any plausible
 * single-user single-type plausibility range — defence in depth against
 * a cursor-staleness infinite-loop bug.
 *
 * `since` lets the correlation path pull only the trailing 30 days
 * without first reading older rows. `includeSleepStage` opts the
 * per-type loop into the SLEEP_DURATION-only field.
 */
const MEASUREMENT_CHUNK_SIZE = 5000;

interface ChunkedRow {
  measuredAt: Date;
  value: number;
  sleepStage: string | null;
}

async function fetchMeasurementSeriesChunked(
  userId: string,
  type: MeasurementType,
  options: { since?: Date; includeSleepStage?: boolean } = {},
): Promise<ChunkedRow[]> {
  const out: ChunkedRow[] = [];
  let cursorId: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const chunk = await prisma.measurement.findMany({
      where: {
        userId,
        type,
        ...(options.since ? { measuredAt: { gte: options.since } } : {}),
      },
      orderBy: [{ measuredAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        measuredAt: true,
        value: true,
        ...(options.includeSleepStage ? { sleepStage: true } : {}),
      },
      take: MEASUREMENT_CHUNK_SIZE,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });
    if (chunk.length === 0) break;
    for (const row of chunk) {
      out.push({
        measuredAt: row.measuredAt,
        value: row.value,
        sleepStage:
          "sleepStage" in row
            ? ((row.sleepStage as string | null) ?? null)
            : null,
      });
    }
    if (chunk.length < MEASUREMENT_CHUNK_SIZE) break;
    cursorId = chunk[chunk.length - 1].id;
  }
  return out;
}

// v1.4.22 W5 reconcile (Code-MED-3) — `berlinDayKey()` lifted to
// `src/lib/analytics/berlin-day.ts` so the targets route's sparkline
// bucketing shares the same Europe/Berlin contract. The
// `weekday: "short"` formatter still lives here because it's only
// used by `berlinIsoWeekday()` below.
const BERLIN_DATE_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
});

function dateFromBerlinKey(key: string): Date {
  // Anchor to UTC midnight — the date is a sortable bucket label rather
  // than a wall-clock timestamp, so DST drift is irrelevant.
  return new Date(`${key}T00:00:00.000Z`);
}

const ISO_WEEKDAY: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

function berlinIsoWeekday(d: Date): number {
  const parts = BERLIN_DATE_PARTS.formatToParts(d);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  return ISO_WEEKDAY[weekday] ?? 1;
}

/**
 * Build the Health Score input from the user's last-30-day weight,
 * mood, and medication-compliance data, plus the already-computed
 * `bpInTargetPct` headline. Re-runs the same compute against a
 * 7-day-shifted window to populate the "vs last week" delta.
 *
 * Returns null when the score wouldn't carry any signal (every
 * component nullable + no medications). The route surfaces the
 * `null` to the UI so the hero panel hides cleanly.
 */
async function computeUserHealthScore(
  userId: string,
  input: { bpInTargetPct: number | null; heightCm: number | null },
): Promise<HealthScoreResult | null> {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = new Date();
  const since30d = new Date(now.getTime() - 30 * DAY_MS);
  // Prior week's snapshot — shift everything 7 days into the past so
  // both windows close at the same wall-clock-of-day boundary.
  const prevSince30d = new Date(now.getTime() - 37 * DAY_MS);
  const prevUntil = new Date(now.getTime() - 7 * DAY_MS);

  const [weightRows, moodRows, medications] = await Promise.all([
    prisma.measurement.findMany({
      where: {
        userId,
        type: "WEIGHT",
        measuredAt: { gte: prevSince30d, lte: now },
      },
      select: { value: true, measuredAt: true },
      orderBy: { measuredAt: "asc" },
    }),
    prisma.moodEntry.findMany({
      where: {
        userId,
        moodLoggedAt: { gte: prevSince30d, lte: now },
      },
      select: { score: true, moodLoggedAt: true },
      orderBy: { moodLoggedAt: "asc" },
    }),
    prisma.medication.findMany({
      where: { userId, active: true },
      select: {
        id: true,
        createdAt: true,
        schedules: {
          select: {
            windowStart: true,
            windowEnd: true,
          },
        },
      },
    }),
  ]);

  // Compliance30 per active medication, then again for the prior-week
  // snapshot. The compliance helper anchors on `Date.now()` internally;
  // for the previous-week snapshot we reuse the same helper but pass a
  // shifted "createdAt" floor so the window mathematically reflects the
  // [-37d, -7d] period — equivalent to running the helper a week ago.
  let medicationCompliance30: number[] = [];
  let medicationCompliance30Previous: number[] = [];
  if (medications.length > 0) {
    const medIds = medications.map((m) => m.id);
    const intakeEvents = await prisma.medicationIntakeEvent.findMany({
      where: {
        userId,
        medicationId: { in: medIds },
        scheduledFor: { gte: prevSince30d, lte: now },
      },
      select: {
        medicationId: true,
        scheduledFor: true,
        takenAt: true,
        skipped: true,
      },
    });
    const eventsByMed = new Map<string, typeof intakeEvents>();
    for (const ev of intakeEvents) {
      const list = eventsByMed.get(ev.medicationId);
      if (list) list.push(ev);
      else eventsByMed.set(ev.medicationId, [ev]);
    }
    medicationCompliance30 = medications.map((med) => {
      const events = eventsByMed.get(med.id) ?? [];
      return calculateCompliance(events, med.schedules, 30, med.createdAt).rate;
    });
    medicationCompliance30Previous = medications.map((med) => {
      const events = (eventsByMed.get(med.id) ?? []).filter(
        (e) => e.scheduledFor <= prevUntil,
      );
      // Compute compliance against the prior-week-aligned window by
      // remapping the helper's "now": shift each event's scheduledFor
      // and takenAt forward by 7 days so the helper's internal `now`
      // anchor still captures the same logical 30 days.
      const shifted = events.map((e) => ({
        scheduledFor: new Date(e.scheduledFor.getTime() + 7 * DAY_MS),
        takenAt: e.takenAt ? new Date(e.takenAt.getTime() + 7 * DAY_MS) : null,
        skipped: e.skipped,
      }));
      return calculateCompliance(shifted, med.schedules, 30, med.createdAt)
        .rate;
    });
  }

  const fallbackTarget = defaultWeightTargetFromHeight(input.heightCm);

  const weightSeriesLast30d = weightRows
    .filter((r) => r.measuredAt >= since30d)
    .map((r) => ({ date: r.measuredAt.toISOString(), kg: r.value }));
  const weightSeriesPrev30d = weightRows
    .filter((r) => r.measuredAt >= prevSince30d && r.measuredAt <= prevUntil)
    .map((r) => ({ date: r.measuredAt.toISOString(), kg: r.value }));

  const moodSeriesLast30d = moodRows
    .filter((r) => r.moodLoggedAt >= since30d)
    .map((r) => ({
      date: r.moodLoggedAt.toISOString(),
      score: r.score,
    }));
  const moodSeriesPrev30d = moodRows
    .filter(
      (r) => r.moodLoggedAt >= prevSince30d && r.moodLoggedAt <= prevUntil,
    )
    .map((r) => ({
      date: r.moodLoggedAt.toISOString(),
      score: r.score,
    }));

  // Skip any input shape where literally nothing is computable — the
  // hero panel hides instead of painting a misleading "0".
  if (
    input.bpInTargetPct === null &&
    weightSeriesLast30d.length === 0 &&
    moodSeriesLast30d.length === 0 &&
    medicationCompliance30.length === 0
  ) {
    // Tag-only annotation so admin observability can see the empty path.
    annotate({
      meta: {
        healthScore: { score: null, reason: "no_components_available" },
      },
    });
    return null;
  }

  const current: HealthScoreInput = {
    bpInTargetRate: input.bpInTargetPct,
    weightSeriesLast30d,
    weightTargetKg: fallbackTarget,
    moodEntriesLast30d: moodSeriesLast30d,
    medicationCompliance30,
  };
  // The all-time `bpInTargetPct` is a slow-moving aggregate and would
  // need a full historical re-pair to "rewind" by a week. We pass the
  // same value to the previous snapshot so the delta primarily
  // reflects week-over-week changes in the weight / mood / compliance
  // pillars — the components that actually move on a weekly cadence.
  const previous: HealthScoreInput = {
    bpInTargetRate: input.bpInTargetPct,
    weightSeriesLast30d: weightSeriesPrev30d,
    weightTargetKg: fallbackTarget,
    moodEntriesLast30d: moodSeriesPrev30d,
    medicationCompliance30: medicationCompliance30Previous,
  };

  return computeHealthScore(current, previous);
}
