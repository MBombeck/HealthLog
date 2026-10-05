/**
 * Briefing-scoped feature read blocks: full-history extremes, the
 * bucketed rollup series, and the v1.22 cross-signal integration blocks
 * (flagged labs, preventive-care due/overdue, workout aggregate). Each
 * is one bounded DB read projecting to its slice of the
 * `AggregatedFeatures` payload.
 *
 * Extracted verbatim from `features.ts`, which re-exports this module
 * so every existing call site keeps importing from there; the assembly
 * point (`extractFeatures`) stays in the hub.
 */
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { buildSourceRankCase } from "@/lib/analytics/source-rank-sql";
import {
  dayWeightedRowsSql,
  foldMeanSql,
  isHourlyMeanTypeSql,
} from "@/lib/measurements/day-mean";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { classifyAgainstEffectiveRange } from "@/lib/labs/reference-range";
import { calendarDaysUntil } from "@/lib/measurement-reminders/due-day";
import { resolveLabFields } from "@/lib/labs/serialise";
import { readRollupBuckets } from "@/lib/rollups/measurement-rollups";
import { deriveBucketedTypes } from "@/lib/signals/adapters/correlation";
import type {
  AggregatedFeatures,
  BucketedSeries,
} from "@/lib/insights/features";
import type {
  MeasurementType,
  RollupGranularity,
} from "@/generated/prisma/client";

/** All-time aggregate (full history) for one measurement type. */
interface AllTimeExtremes {
  mean: number | null;
  min: number | null;
  max: number | null;
}

/**
 * v1.18.11 P1 — full-history min / max / mean per measurement type via ONE
 * grouped SQL aggregation, with NO row materialisation in JS. Fills the
 * `allTime*` feature fields; the windowed `summarize()` covers trends + recent
 * windows, and this covers the long-horizon figures the prompt labels
 * "allTime".
 *
 * One source per (type, day): each source is folded per day first, each day
 * keeps its ladder-canonical source, then the days fold into the figures —
 * the same pick the dashboard's all-time figures make. Averaging every raw
 * row let a device that samples densely (a watch's pulse) outweigh the
 * readings the source ladder prefers on the same days.
 *
 * Only the four types that expose `allTime*` fields are aggregated (weight,
 * systolic, diastolic, pulse). Returns a map keyed by `MeasurementType`; a type
 * with no rows is simply absent.
 */
export async function readAllTimeExtremes(
  userId: string,
  types: readonly MeasurementType[],
  /**
   * The Coach's lookback floor. Given, "all time" means all the history the
   * Coach may read, and nothing older enters the figures.
   */
  floor: Date | null = null,
): Promise<Map<MeasurementType, AllTimeExtremes>> {
  const out = new Map<MeasurementType, AllTimeExtremes>();
  if (types.length === 0) return out;
  const since =
    floor === null ? Prisma.empty : Prisma.sql`AND m."measured_at" >= ${floor}`;
  const priorityJson = await loadUserSourcePriority(userId);
  const rank = Prisma.raw(
    buildSourceRankCase(priorityJson, 'p."type"', 'p."source"'),
  );
  const typeList = Prisma.join(
    types.map((t) => Prisma.sql`${t}::measurement_type`),
  );
  // A day of pulse is the mean of its hours' means and the full history the
  // mean of its days (`day-mean.ts`). `weighted` carries, per source and day,
  // the day-weighted sum and the day's weight (one) for those types only;
  // every other type keeps the reading-weighted mean below, unchanged.
  const mean = Prisma.raw(
    foldMeanSql({
      typeColumn: 'c."type"',
      total: "c.total",
      count: "c.cnt",
      weightedSum: "c.wsum",
      weightSum: "c.wdays",
    }),
  );
  const rows = await prisma.$queryRaw<
    Array<{ type: string; mean: number; min: number; max: number }>
  >`
    WITH hourly_src AS (
      SELECT m.*
      FROM measurements m
      WHERE m."user_id" = ${userId}
        AND m."deleted_at" IS NULL
        AND m."type" IN (${typeList})
        ${since}
        AND ${Prisma.raw(isHourlyMeanTypeSql('m."type"'))}
    ),
    weighted AS (
      SELECT
        w."type",
        w."source",
        date_trunc('day', w."measured_at")              AS day,
        SUM(w."value" * w.day_weight)::double precision AS wsum,
        SUM(w.day_weight)::double precision             AS wdays
      FROM ${dayWeightedRowsSql("hourly_src", null, { bySource: true })} w
      GROUP BY w."type", w."source", 3
    ),
    per_source AS (
      SELECT
        m."type",
        m."source",
        date_trunc('day', m."measured_at") AS day,
        COUNT(*)::int                      AS cnt,
        SUM(m."value")::double precision   AS total,
        MIN(m."value")::double precision   AS min_value,
        MAX(m."value")::double precision   AS max_value
      FROM measurements m
      WHERE m."user_id" = ${userId}
        AND m."deleted_at" IS NULL
        AND m."type" IN (${typeList})
        ${since}
      GROUP BY m."type", m."source", 3
    ),
    canon AS (
      SELECT DISTINCT ON (p."type", p.day)
        p."type", p.cnt, p.total, p.min_value, p.max_value, w.wsum, w.wdays
      FROM per_source p
      LEFT JOIN weighted w
        ON w."type" = p."type" AND w."source" = p."source" AND w.day = p.day
      ORDER BY p."type", p.day, (${rank}), p."source"::text
    )
    SELECT
      c."type"::text                                  AS type,
      ${mean}::double precision                       AS mean,
      MIN(c.min_value)::double precision              AS min,
      MAX(c.max_value)::double precision              AS max
    FROM canon c
    GROUP BY c."type"
  `;
  for (const r of rows) {
    out.set(r.type as MeasurementType, {
      mean: r.mean === null ? null : Number(r.mean),
      min: r.min === null ? null : Number(r.min),
      max: r.max === null ? null : Number(r.max),
    });
  }
  return out;
}

/**
 * v1.4.36 W3 T1 — bucket-window definitions for the
 * `bucketedMeasurements` payload. Mirrors the rollup populator's
 * granularity ladder so the read-side picks up whatever the persistent
 * table holds without a recompute round-trip.
 *
 * The 90 / 365 / 1825-day windows are non-overlapping: each row of
 * `measurement_rollups` lives at exactly one granularity, and the
 * downstream model reads the union of the three series per type.
 * Total volume per type for a heavy power user (5 years of daily
 * data): 90 DAY + 39 WEEK + 50 MONTH = 179 buckets × ~40 bytes JSON
 * each ≈ 7 KB. Eight metric types lands at ~56 KB — well under the
 * 5 MB cap above, vs 25.9 MB for the v1.4.35 rawMeasurements shape.
 */
const BUCKET_WINDOWS: Array<{
  granularity: RollupGranularity;
  fromDays: number;
  toDays: number;
}> = [
  { granularity: "DAY", fromDays: 0, toDays: 90 },
  { granularity: "WEEK", fromDays: 90, toDays: 365 },
  { granularity: "MONTH", fromDays: 365, toDays: 1825 },
];

/**
 * Types the bucketed payload covers. Mirrors the aggregate branches
 * above so the model never sees a bucket for a metric whose aggregate
 * block was suppressed. New `MeasurementType` enum values flow in by
 * adding one row; the rollup populator already covers every type.
 */
// Derived from the signal registry: every signal flagged
// `surfaces.correlationEligible` projects to its DB `MeasurementType`. The list
// is a membership/iteration set (each type is read independently), so order is
// not significant; the registry-invariant test pins the set byte-for-byte.
const BUCKETED_TYPES: MeasurementType[] = deriveBucketedTypes();

/** Days a preventive-care item must be due within to surface as "due soon". */
const PREVENTIVE_DUE_HORIZON_DAYS = 21;

/** Cap on items surfaced per preventive-care bucket. */
const PREVENTIVE_MAX_PER_BUCKET = 5;

/** Cap on flagged biomarkers surfaced to the briefing. */
const LABS_MAX_FLAGGED = 8;

/** Only lab readings within this many months are considered "recent". */
const LABS_LOOKBACK_MONTHS = 12;

/** Trailing window (days) for the workout aggregate. */
const WORKOUT_WINDOW_DAYS = 90;

/** Trailing window (days) for the ECG recording descriptor. */
const ECG_WINDOW_DAYS = 90;

/** Defensive cap on ECG rows read for the descriptor (a bound, not a ceiling). */
const ECG_MAX_ROWS = 500;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Strip control chars + collapse whitespace, then bound the length, before a
 * user-supplied label can reach the briefing prompt. Mirrors the labs /
 * illness snapshot label handling — a self-scoped prompt-injection surface.
 */
function sanitizeLabel(text: string, max = 80): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * v1.22 — recent FLAGGED biomarkers (abnormal or trending) for the briefing.
 * Most-recent reading per biomarker over the lookback window; hidden markers
 * excluded; qualitative rows neutral. Only abnormal (below/above) OR trending
 * markers surface, bounded. Returns `undefined` when nothing is flagged so the
 * block is omitted rather than emitting an empty shape.
 */
export async function readLabsBriefingBlock(
  userId: string,
  now: number,
): Promise<AggregatedFeatures["labs"] | undefined> {
  const nowDate = new Date(now);
  const cutoff = new Date(nowDate);
  cutoff.setMonth(cutoff.getMonth() - LABS_LOOKBACK_MONTHS);

  const rows = await prisma.labResult.findMany({
    where: { userId, deletedAt: null, takenAt: { gte: cutoff, lte: nowDate } },
    orderBy: { takenAt: "desc" },
    take: LABS_MAX_FLAGGED * 16,
    select: {
      analyte: true,
      panel: true,
      unit: true,
      value: true,
      valueText: true,
      referenceLow: true,
      referenceHigh: true,
      sourceReferenceLow: true,
      sourceReferenceHigh: true,
      sourceReferenceText: true,
      takenAt: true,
      biomarkerId: true,
      biomarker: {
        select: {
          id: true,
          name: true,
          unit: true,
          lowerBound: true,
          upperBound: true,
          panel: true,
          hidden: true,
        },
      },
    },
  });
  if (rows.length === 0) return undefined;

  // Group rows per biomarker identity (linked id, else lower-cased analyte),
  // newest-first, so we can read the latest reading + the immediately prior one
  // for a trend. Hidden markers are dropped entirely.
  const byMarker = new Map<string, typeof rows>();
  for (const row of rows) {
    if (row.biomarker?.hidden) continue;
    const resolved = resolveLabFields(row, row.biomarker);
    const key = row.biomarkerId ?? `analyte:${resolved.analyte.toLowerCase()}`;
    const list = byMarker.get(key) ?? [];
    list.push(row);
    byMarker.set(key, list);
  }

  const flagged: NonNullable<AggregatedFeatures["labs"]>["flagged"] = [];
  for (const list of byMarker.values()) {
    const latest = list[0];
    const resolved = resolveLabFields(latest, latest.biomarker);
    const rangeStatus = classifyAgainstEffectiveRange(
      latest.value,
      resolved.effectiveRange,
    );

    // Trend = latest numeric reading vs the immediately prior numeric reading.
    let trend: "rising" | "falling" | "flat" | null = null;
    if (latest.value !== null) {
      const prior = list.find((r, i) => i > 0 && r.value !== null);
      if (prior?.value != null) {
        const delta = latest.value - prior.value;
        const eps = Math.max(Math.abs(prior.value) * 0.02, 1e-9);
        trend = delta > eps ? "rising" : delta < -eps ? "falling" : "flat";
      }
    }

    const isAbnormal = rangeStatus === "below" || rangeStatus === "above";
    const isTrending = trend === "rising" || trend === "falling";
    if (!isAbnormal && !isTrending) continue;

    flagged.push({
      analyte: resolved.analyte,
      value: latest.value,
      valueText: latest.valueText ? sanitizeLabel(latest.valueText, 60) : null,
      unit: resolved.unit,
      rangeStatus,
      trend,
      takenAt: latest.takenAt.toISOString(),
      daysAgo: Math.round((now - latest.takenAt.getTime()) / MS_PER_DAY),
    });
  }

  if (flagged.length === 0) return undefined;
  // Abnormal markers lead, then most-recent first.
  flagged.sort((a, b) => {
    const abn = (s: typeof a.rangeStatus) =>
      s === "below" || s === "above" ? 0 : 1;
    const d = abn(a.rangeStatus) - abn(b.rangeStatus);
    return d !== 0 ? d : a.daysAgo - b.daysAgo;
  });
  return {
    flagged: flagged.slice(0, LABS_MAX_FLAGGED),
    flaggedCount: flagged.length,
  };
}

/**
 * v1.22 — preventive-care (Vorsorge) due + overdue read-side. Reads the
 * user's enabled, live reminders and buckets by the server-authoritative
 * `nextDueAt`. Returns `undefined` when nothing is due or overdue.
 *
 * `daysUntil` / `daysOverdue` are CALENDAR days in `timeZone`, counted by the
 * same `calendarDaysUntil` the checkup screens phrase their due line with.
 * They used to be an hour gap divided by 24, which is a different question:
 * a checkup at 09:00 read that evening came out "overdue by 0 days", and one
 * due tomorrow morning read late tonight came out due "in 0 days" — today's.
 * The model narrates these numbers, so it repeated whichever the arithmetic
 * had drifted to while the screen next to it said something else.
 *
 * `timeZone` is the user's profile zone; the horizon that bounds the read
 * stays an hours-based cutoff on purpose — it is a query bound, not a
 * statement to anyone about which day something falls on.
 */
export async function readPreventiveCareBlock(
  userId: string,
  now: number,
  timeZone: string,
): Promise<AggregatedFeatures["preventiveCare"] | undefined> {
  const horizon = new Date(now + PREVENTIVE_DUE_HORIZON_DAYS * MS_PER_DAY);
  const rows = await prisma.measurementReminder.findMany({
    // A booked visit's one-shot reminder rides this same engine with
    // `origin: ENCOUNTER`. It is not a checkup and must not appear on a
    // Vorsorge surface, or the list fills with appointments. Four read
    // sites carry this exclusion; `encounter-reminder-exclusion.test.ts`
    // proves every one of them, and the DTO mapper refuses such a row
    // outright so a site that lost its filter fails loudly.
    where: {
      userId,
      deletedAt: null,
      enabled: true,
      origin: { not: "ENCOUNTER" },
      nextDueAt: { not: null, lte: horizon },
    },
    orderBy: { nextDueAt: "asc" },
    take: (PREVENTIVE_MAX_PER_BUCKET + 1) * 4,
    select: { label: true, nextDueAt: true },
  });
  if (rows.length === 0) return undefined;

  const overdue: NonNullable<AggregatedFeatures["preventiveCare"]>["overdue"] =
    [];
  const due: NonNullable<AggregatedFeatures["preventiveCare"]>["due"] = [];
  const nowDate = new Date(now);
  for (const r of rows) {
    if (!r.nextDueAt) continue;
    const label = sanitizeLabel(r.label);
    if (!label) continue;
    const days = calendarDaysUntil(r.nextDueAt, nowDate, timeZone);
    // Today's checkup is due, not overdue — the hour it was booked for may
    // have passed, but the day it belongs to has not.
    if (days < 0) {
      overdue.push({ label, daysOverdue: -days });
    } else {
      due.push({ label, daysUntil: days });
    }
  }
  if (overdue.length === 0 && due.length === 0) return undefined;
  return {
    overdue: overdue.slice(0, PREVENTIVE_MAX_PER_BUCKET),
    due: due.slice(0, PREVENTIVE_MAX_PER_BUCKET),
  };
}

/**
 * v1.22 — workout aggregate over the trailing window. Provider-agnostic:
 * counts + summed duration + summed distance (km, when any source reported it)
 * over 7 / 30 days, plus the latest workout. Returns `undefined` when no
 * workouts fall in the window.
 */
export async function readWorkoutsBlock(
  userId: string,
  now: number,
): Promise<AggregatedFeatures["workouts"] | undefined> {
  const since = new Date(now - WORKOUT_WINDOW_DAYS * MS_PER_DAY);
  const rows = await prisma.workout.findMany({
    where: { userId, startedAt: { gte: since } },
    orderBy: { startedAt: "desc" },
    take: 2000,
    select: {
      sportType: true,
      startedAt: true,
      durationSec: true,
      totalDistanceM: true,
    },
  });
  if (rows.length === 0) return undefined;

  const tally = (windowDays: number) => {
    const cutoff = now - windowDays * MS_PER_DAY;
    let count = 0;
    let durationSec = 0;
    let distanceM = 0;
    let anyDistance = false;
    for (const w of rows) {
      if (w.startedAt.getTime() < cutoff) continue;
      count += 1;
      durationSec += w.durationSec;
      if (w.totalDistanceM != null) {
        distanceM += w.totalDistanceM;
        anyDistance = true;
      }
    }
    return {
      count,
      totalDurationMin: Math.round(durationSec / 60),
      totalDistanceKm: anyDistance
        ? Math.round((distanceM / 1000) * 10) / 10
        : null,
    };
  };

  const newest = rows[0];
  const latest = {
    sportType: sanitizeLabel(newest.sportType, 40),
    daysAgo: Math.round((now - newest.startedAt.getTime()) / MS_PER_DAY),
    durationMin: Math.round(newest.durationSec / 60),
    distanceKm:
      newest.totalDistanceM != null
        ? Math.round((newest.totalDistanceM / 1000) * 10) / 10
        : null,
  };

  return { last7: tally(7), last30: tally(30), latest };
}

/**
 * S10 — ECG recording descriptor for the briefing narrative (device-verdict
 * only). A bounded, non-diagnostic snapshot of the user's on-device ECG
 * recordings over the trailing window: how many exist, the distribution of the
 * RECORDING DEVICE's OWN verdicts (never HealthLog's), and the latest
 * recording's device verdict + average heart rate. The waveform is NEVER read
 * (no decrypt on this path) and NEVER enters the payload — the trace does not
 * cross into the prompt, so the model cannot interpret morphology. The prompt
 * (insight-generator rule) constrains any mention to the device's attribution;
 * the grounding gate constrains any restated count. Returns `undefined` when no
 * recordings fall in the window, so the block is omitted rather than emitting an
 * empty shape.
 */
export async function readEcgBriefingBlock(
  userId: string,
  now: number,
): Promise<AggregatedFeatures["ecg"] | undefined> {
  const since = new Date(now - ECG_WINDOW_DAYS * MS_PER_DAY);
  const rows = await prisma.ecgRecording.findMany({
    where: { userId, recordedAt: { gte: since } },
    orderBy: { recordedAt: "desc" },
    take: ECG_MAX_ROWS,
    // Descriptors only — the encrypted waveform blob is never selected, so no
    // decrypt happens and no trace can reach the narrative.
    select: {
      recordedAt: true,
      rhythmClassification: true,
      averageHeartRate: true,
    },
  });
  if (rows.length === 0) return undefined;

  const deviceVerdicts = { irregular: 0, notDetected: 0, inconclusive: 0 };
  for (const r of rows) {
    if (r.rhythmClassification === "IRREGULAR") deviceVerdicts.irregular += 1;
    else if (r.rhythmClassification === "NOT_DETECTED")
      deviceVerdicts.notDetected += 1;
    else if (r.rhythmClassification === "INCONCLUSIVE")
      deviceVerdicts.inconclusive += 1;
  }

  // An ECG row only ever carries an AFib-screening verdict; the shared enum's
  // other members (walking-steadiness / event codes) never apply here, so
  // anything else narrows to null.
  const latest = rows[0];
  const latestVerdict = latest.rhythmClassification;
  return {
    recordingCount: rows.length,
    deviceVerdicts,
    latestDeviceVerdict:
      latestVerdict === "IRREGULAR" ||
      latestVerdict === "NOT_DETECTED" ||
      latestVerdict === "INCONCLUSIVE"
        ? latestVerdict
        : null,
    latestRecordedDaysAgo: Math.round(
      (now - latest.recordedAt.getTime()) / MS_PER_DAY,
    ),
    latestAverageHeartRate: latest.averageHeartRate,
  };
}

/**
 * Read every BUCKETED_TYPES × BUCKET_WINDOWS combination from the
 * persistent rollup table and project to the wire shape. Empty
 * (type, granularity) combinations are dropped so the payload never
 * carries a labelled-but-empty series.
 */
export async function readBucketedSeries(
  userId: string,
  now: number,
): Promise<BucketedSeries[]> {
  const series: BucketedSeries[] = [];
  for (const type of BUCKETED_TYPES) {
    for (const window of BUCKET_WINDOWS) {
      const from = new Date(now - window.toDays * 24 * 60 * 60 * 1000);
      const to = new Date(now - window.fromDays * 24 * 60 * 60 * 1000);
      const rows = await readRollupBuckets(
        userId,
        type,
        window.granularity,
        from,
        to,
      );
      if (rows.length === 0) continue;
      series.push({
        type,
        granularity: window.granularity,
        buckets: rows.map((r) => ({
          bucketStart: r.bucketStart.toISOString(),
          mean: Math.round(r.mean * 100) / 100,
          count: r.count,
        })),
      });
    }
  }
  return series;
}
