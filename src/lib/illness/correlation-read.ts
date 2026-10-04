/**
 * Illness correlation engine — the READ layer (v1.18.1, Workstream B / P3).
 *
 * Resolves the per-vital per-day mean series the pure `computeIllnessCorrelation`
 * engine needs, then runs the engine. Two windows per vital, and the seam
 * between them is the BASELINE-CONTAMINATION GUARD:
 *
 *   baselineDays : [onset − lookback − BASELINE_WINDOW_DAYS, onset − lookback)
 *   episodeDays  : [onset − lookback, end]
 *
 * The baseline window ENDS strictly before the pre-onset lookback, so no day
 * inside (or just before) the episode can poison the baseline the episode is
 * measured against. This is the single most important reliability property of
 * the engine — a baseline that includes the illness days would shrink every
 * deviation toward zero and silently under-report the very anomaly we exist to
 * surface.
 *
 * Reads are DAY-native (the spread invariant forbids composing a band from a
 * coarser tier's `sd`): the rollup DAY tier when covered, a bounded per-type
 * live-SQL fallback on a coverage miss. EVERY per-day key is the USER'S local
 * day (`dayKeyForUserTz`), never a raw UTC slice — the onset/feltBetter markers
 * are already keyed in the user's tz, so the vital series must match or a
 * non-UTC user gets an off-by-one (a 03:00Z reading is local D−1 but UTC D).
 * Rollup DAY buckets are minted at the UTC midnight of the user-tz day, so
 * keying their `bucketStart` through `dayKeyForUserTz` is exact.
 */
import pLimit from "p-limit";
import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { readBestGranularityRollups } from "@/lib/rollups/measurement-read-wmy";
import { probeRollupCoverage } from "@/lib/rollups/measurement-coverage";
import { dayKeyForUserTz } from "@/lib/measurements/consolidation-tz";
import { dayValue } from "@/lib/measurements/day-mean";
import { resolveUserTimezone } from "@/lib/measurements/consolidation-base";
import { reconstructNights } from "@/lib/insights/derived/sleep-score";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import type { Derived } from "@/lib/insights/derived/types";
import {
  BASELINE_WINDOW_DAYS,
  ILLNESS_SCAN_TYPES,
  PRE_ONSET_LOOKBACK_DAYS,
  computeIllnessCorrelation,
  type DayLogFeverPoint,
  type IllnessCorrelationValue,
  type SleepNightPoint,
  type SymptomBurdenPoint,
  type VitalSeries,
} from "./correlation";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Bound the per-vital fan-out so a single episode's scan can't pin the
 * shared Prisma pool. Mirrors the W-POOL `p-limit(4)` discipline the
 * analytics summaries slice applies.
 */
const VITAL_SCAN_CONCURRENCY = 4;

/** The episode shape the read layer needs (a subset of the Prisma row). */
export interface EpisodeForCorrelation {
  id: string;
  onsetAt: Date;
  resolvedAt: Date | null;
  lifecycle: string;
}

/** A windowed per-day read: mean + max per local day, with provenance. */
interface WindowRead {
  points: { day: string; mean: number; max: number }[];
  source: "DAY" | "live" | "none";
}

/**
 * Resolve the per-vital series for one episode (contamination-guarded
 * baseline window) and run the pure engine. Returns the same gated
 * `Derived<T>` the engine returns — `insufficient` flows straight through.
 */
export async function computeEpisodeCorrelation(
  userId: string,
  episode: EpisodeForCorrelation,
  timezone: string | null,
  now: Date = new Date(),
): Promise<Derived<IllnessCorrelationValue>> {
  const tz = resolveUserTimezone(timezone);
  const onset = episode.onsetAt;
  const end = episode.resolvedAt ?? now;

  // Window seams (UTC instants; the day keys are read in the user's tz).
  const preOnsetStart = new Date(
    onset.getTime() - PRE_ONSET_LOOKBACK_DAYS * MS_PER_DAY,
  );
  const baselineEnd = preOnsetStart; // baseline ends where the lookback starts
  const baselineStart = new Date(
    baselineEnd.getTime() - BASELINE_WINDOW_DAYS * MS_PER_DAY,
  );

  const onsetDay = dayKeyForUserTz(onset, tz);
  const feltBetterDay = episode.resolvedAt
    ? dayKeyForUserTz(episode.resolvedAt, tz)
    : null;

  // One coverage probe shared across every vital read (pool-contention
  // mitigation — the same pattern the derived route uses). The source priority
  // feeds the canonical sleep-night writer-dedup (same ladder every sleep
  // surface uses), resolved once.
  const [coverage, sleepPriorityJson] = await Promise.all([
    probeRollupCoverage(userId),
    loadUserSourcePriority(userId),
  ]);

  // Attempt every scan type under a bounded concurrency cap. The two
  // windows per type (baseline + episode) are independent reads, so they
  // run paired rather than serially (halving the per-type round-trips).
  // The day-log fever read shares the same fan-out budget.
  const limit = pLimit(VITAL_SCAN_CONCURRENCY);
  const [perType, dayLogFever, symptomBurden, sleepNights] = await Promise.all([
    Promise.all(
      ILLNESS_SCAN_TYPES.map((type) =>
        limit(async () => {
          const [baseline, episodeWin] = await Promise.all([
            readWindowMeans(
              userId,
              type,
              baselineStart,
              baselineEnd,
              coverage,
              tz,
              now,
            ),
            readWindowMeans(
              userId,
              type,
              preOnsetStart,
              end,
              coverage,
              tz,
              now,
            ),
          ]);
          return { type, baseline, episodeWin };
        }),
      ),
    ),
    limit(() => readDayLogFever(episode.id, preOnsetStart, end, tz)),
    limit(() => readDayLogSymptomBurden(episode.id, preOnsetStart, end, tz)),
    limit(() =>
      readEpisodeSleepNights(
        userId,
        { baselineStart, baselineEnd, preOnsetStart, end },
        tz,
        sleepPriorityJson,
      ),
    ),
  ]);

  const series: VitalSeries[] = [];
  let anyLive = false;
  let anyDay = false;
  for (const { type, baseline, episodeWin } of perType) {
    if (baseline.points.length === 0 && episodeWin.points.length === 0)
      continue;
    if (baseline.source === "live" || episodeWin.source === "live")
      anyLive = true;
    if (baseline.source === "DAY" || episodeWin.source === "DAY") anyDay = true;
    series.push({
      type,
      baselineDays: baseline.points.map((p) => ({ day: p.day, mean: p.mean })),
      episodeDays: episodeWin.points.map((p) => ({ day: p.day, mean: p.mean })),
      // Per-day max over the episode window — the fever red-flag prefers it so
      // an evening spike averaged toward normal in the daily mean is not masked.
      episodeDayMax: episodeWin.points.map((p) => ({
        day: p.day,
        mean: p.max,
      })),
    });
  }

  const source: "DAY" | "live" | "none" = anyDay
    ? "DAY"
    : anyLive
      ? "live"
      : "none";

  return computeIllnessCorrelation({
    episodeId: episode.id,
    window: { onsetDay, feltBetterDay, lifecycle: episode.lifecycle },
    series,
    dayLogFever,
    symptomBurden,
    baselineNights: sleepNights.baselineNights,
    episodeNights: sleepNights.episodeNights,
    source,
    now,
  });
}

/**
 * Per-day mean + max for `(userId, type)` over an explicit [from, to) window,
 * keyed by the USER'S local day. The DAY rollup serves the trailing
 * (`to ≈ now`) case; otherwise a bounded raw read groups per local day. The
 * tz-keying is what keeps the contamination-guard seam and the onset/felt-
 * better markers in the same calendar for a non-UTC user.
 */
async function readWindowMeans(
  userId: string,
  type: MeasurementType,
  from: Date,
  to: Date,
  coverage: Awaited<ReturnType<typeof probeRollupCoverage>>,
  tz: string,
  now: Date,
): Promise<WindowRead> {
  const toIsNow = Math.abs(to.getTime() - now.getTime()) < MS_PER_DAY;

  if (toIsNow && coverage.get(type) === true) {
    const windowDays = Math.max(
      1,
      Math.ceil((to.getTime() - from.getTime()) / MS_PER_DAY),
    );
    const resolved = await readBestGranularityRollups(userId, type, windowDays);
    if (
      resolved &&
      resolved.granularity === "DAY" &&
      resolved.rows.length > 0
    ) {
      const fromKey = dayKeyForUserTz(from, tz);
      // DAY buckets are minted at the UTC midnight of the user-tz day, so
      // keying `bucketStart` through the user tz is exact.
      const points = resolved.rows
        .map((row) => ({
          day: dayKeyForUserTz(row.bucketStart, tz),
          mean: row.mean,
          max: row.maxValue ?? row.mean,
        }))
        .filter((p) => p.day >= fromKey)
        .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
      if (points.length > 0) return { points, source: "DAY" };
    }
    // Coverage said "has buckets" but the window resolved coarser / empty →
    // fall through to the live read so the series stays DAY-native.
  }

  // Bounded raw fallback — group per the USER'S local day (never a UTC slice).
  // A trailing window (`to ≈ now`) reads open-ended (gte only) so it stays a
  // "trailing" read; a bounded window pins `lt` so it can never reach past its
  // seam (the contamination guard for the baseline window).
  const measuredAt = toIsNow ? { gte: from } : { gte: from, lt: to };
  const rows = await prisma.measurement.findMany({
    where: { userId, type, deletedAt: null, measuredAt },
    orderBy: { measuredAt: "asc" },
    select: { value: true, measuredAt: true },
  });
  if (rows.length === 0) return { points: [], source: "none" };
  const byDay = new Map<string, { rows: typeof rows; max: number }>();
  for (const row of rows) {
    const day = dayKeyForUserTz(row.measuredAt, tz);
    const acc = byDay.get(day) ?? { rows: [], max: -Infinity };
    acc.rows.push(row);
    acc.max = Math.max(acc.max, row.value);
    byDay.set(day, acc);
  }
  // The day's mean is the type's day value (`day-mean.ts`): the mean of its
  // local hours' means for pulse, the mean of its readings otherwise. The
  // max stays over every reading.
  const points = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, acc]) => ({
      day,
      mean: dayValue(type, acc.rows, tz) as number,
      max: acc.max,
    }));
  return { points, source: "live" };
}

/**
 * Read the illness day-log `feverC` series over [from, to) as per-day MAX
 * fever points (keyed by the stored `date`, which is already the user-tz day
 * string the day-log was logged under). Drops null fevers.
 */
async function readDayLogFever(
  episodeId: string,
  from: Date,
  to: Date,
  tz: string,
): Promise<DayLogFeverPoint[]> {
  const fromKey = dayKeyForUserTz(from, tz);
  const toKey = dayKeyForUserTz(to, tz);
  const rows = await prisma.illnessDayLog.findMany({
    where: {
      episodeId,
      deletedAt: null,
      feverC: { not: null },
      date: { gte: fromKey, lte: toKey },
    },
    select: { date: true, feverC: true },
  });
  const byDay = new Map<string, number>();
  for (const row of rows) {
    if (row.feverC == null) continue;
    byDay.set(row.date, Math.max(byDay.get(row.date) ?? -Infinity, row.feverC));
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, feverC]) => ({ day, feverC }));
}

/**
 * Read the illness day-log symptom-burden series over [from, to) — the user's
 * own logged daily-impact curve, keyed by the stored `date` (already the
 * user-tz day string, so NO tz conversion). Mirrors `readDayLogFever`: one
 * `findMany`, present days only, no zero-fill.
 *
 * Per day the burden is `functionalImpact` (0–3, the deliberate daily slider)
 * when logged; else the day's MAX linked `IllnessSymptomLink.severity` (0–3) as
 * a fallback corroborator. A day with neither is dropped (absent from the
 * series — the engine treats a missing day as "not logged", never an
 * implicit 0).
 */
async function readDayLogSymptomBurden(
  episodeId: string,
  from: Date,
  to: Date,
  tz: string,
): Promise<SymptomBurdenPoint[]> {
  const fromKey = dayKeyForUserTz(from, tz);
  const toKey = dayKeyForUserTz(to, tz);
  const rows = await prisma.illnessDayLog.findMany({
    where: {
      episodeId,
      deletedAt: null,
      date: { gte: fromKey, lte: toKey },
    },
    select: {
      date: true,
      functionalImpact: true,
      symptomLinks: { select: { severity: true } },
    },
  });
  const points: SymptomBurdenPoint[] = [];
  for (const row of rows) {
    if (row.functionalImpact != null) {
      points.push({ day: row.date, impact: row.functionalImpact });
      continue;
    }
    // Fallback corroborator: the day's strongest linked symptom severity.
    let maxSeverity: number | null = null;
    for (const link of row.symptomLinks) {
      if (link.severity == null) continue;
      maxSeverity =
        maxSeverity === null
          ? link.severity
          : Math.max(maxSeverity, link.severity);
    }
    if (maxSeverity != null)
      points.push({ day: row.date, impact: maxSeverity });
  }
  return points.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/**
 * Reconstruct per-night asleep totals over the well baseline window AND the
 * episode window for the sleep-as-context observation. Reuses the canonical
 * `reconstructNights` engine wholesale (session-clustering, local-wake-day
 * keying, multi-source writer-dedup — a WHOOP + Apple Health night is counted
 * ONCE) so the figures match every other sleep surface. The night's `night`
 * key is ALREADY the local wake-day string, so it joins the engine's
 * onset/feltBetter day-space directly — no extra tz conversion.
 *
 * Two windows mirror the vital reads' contamination-guard seam:
 *   baselineNights : [baselineStart, baselineEnd)  → the user's well baseline
 *   episodeNights  : [preOnsetStart, end]          → the episode span
 *
 * Each is a single bounded `findMany` over the raw per-stage SLEEP_DURATION
 * rows; the engine withholds the observation entirely on thin data.
 */
async function readEpisodeSleepNights(
  userId: string,
  windows: {
    baselineStart: Date;
    baselineEnd: Date;
    preOnsetStart: Date;
    end: Date;
  },
  tz: string,
  priorityJson: unknown,
): Promise<{
  baselineNights: SleepNightPoint[];
  episodeNights: SleepNightPoint[];
}> {
  const select = {
    value: true,
    measuredAt: true,
    sleepStage: true,
    source: true,
    deviceType: true,
  } as const;

  const [baselineRows, episodeRows] = await Promise.all([
    prisma.measurement.findMany({
      where: {
        userId,
        type: "SLEEP_DURATION" satisfies MeasurementType,
        deletedAt: null,
        measuredAt: { gte: windows.baselineStart, lt: windows.baselineEnd },
      },
      orderBy: { measuredAt: "asc" },
      select,
    }),
    prisma.measurement.findMany({
      where: {
        userId,
        type: "SLEEP_DURATION" satisfies MeasurementType,
        deletedAt: null,
        measuredAt: { gte: windows.preOnsetStart, lte: windows.end },
      },
      orderBy: { measuredAt: "asc" },
      select,
    }),
  ]);

  const toPoints = (rows: typeof baselineRows): SleepNightPoint[] =>
    reconstructNights(rows, tz, priorityJson)
      .filter((n) => n.asleepMinutes > 0)
      .map((n) => ({ day: n.night, asleepMinutes: n.asleepMinutes }));

  return {
    baselineNights: toPoints(baselineRows),
    episodeNights: toPoints(episodeRows),
  };
}
