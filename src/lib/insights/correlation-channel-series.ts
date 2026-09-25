/**
 * v1.21.0 (INTEGFIX) — the DB reads behind the correlation-discovery channels.
 *
 * The pure series shapers live in `correlation-series-builders.ts`; the FDR
 * engine itself is pure over `NamedSeries[]`. These helpers own the reads that
 * feed those shapers — the dose-history ledger (compliance), the illness day-log
 * (symptom severity), the daily weather rows, the opt-in custom metrics, the
 * measurement window (raw and rollup-tiered), the mood window — so the queries,
 * the tz keying and the episode-span clamping exist once.
 *
 * This module owns FETCHING one channel at a time. It does NOT decide which
 * channels a surface gets: that is `discovery-matrix.ts`, the one assembler
 * every consumer of the matrix calls. Fetch discipline was hoisted here in
 * v1.30.3 and the assembly was left behind at four call sites, which is how the
 * Coach tool spent v1.25 onward scanning a matrix with no weather in it. Add a
 * channel here, admit it there, and every surface has it.
 *
 * Each helper degrades to an EMPTY series when the user has no data, so the
 * channel drops out of discovery (it cannot clear the n ≥ 20 floor) rather than
 * fabricating a constant.
 */
import { prisma } from "@/lib/db";
import {
  buildComplianceMedicationContext,
  buildMedicationComplianceBundle,
  lastNonSkippedTakenAt,
  SCHEDULE_COMPLIANCE_SELECT,
} from "@/lib/analytics/compliance";
import {
  FACTOR_CHANNEL_PREFIX,
  MEDICATION_COMPLIANCE_CHANNEL_KEY,
  SYMPTOM_SEVERITY_CHANNEL_KEY,
  type DailySeriesPoint,
  type LabDrawPoint,
  type NamedSeries,
} from "@/lib/insights/correlation-discovery";
import { resolveLabFields } from "@/lib/labs/serialise";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import { ENVIRONMENT_FIELDS } from "@/lib/environment/fields";
import {
  buildComplianceDailySeries,
  buildSymptomSeverityDailySeries,
  type SymptomDayLogRow,
  type SymptomEpisodeSpan,
} from "@/lib/insights/correlation-series-builders";
import type { DoseHistoryRow } from "@/lib/medications/scheduling/dose-history";
import { CUMULATIVE_HK_TYPES } from "@/lib/measurements/apple-health-mapping";
import { metricKeyForType } from "@/lib/measurements/cumulative-day-sum";
import { pickCanonicalSourceRows } from "@/lib/analytics/source-priority";
import {
  reconstructSleepSessions,
  pickMainNightAndNaps,
  type SleepStageRow,
} from "@/lib/analytics/sleep-night";
import { isNearUtc } from "@/lib/tz/format";
import { probeRollupCoverage } from "@/lib/rollups/measurement-coverage";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import type {
  MeasurementSource,
  MeasurementType,
} from "@/generated/prisma/client";
import { TRACKED_INTAKE_WHERE } from "@/lib/medications/intake-tracking";

/**
 * v1.21.0 (FDREXTEND) — build the user's MEDICATION_COMPLIANCE daily series.
 *
 * Pools every active, non-PRN medication's unified dose-history ledger over the
 * window, then collapses to one per-day adherence rate (user-tz day keys). A
 * user with no active medications (or no resolved slots) yields an empty
 * series, so the channel degrades to absent.
 */
export async function fetchComplianceSeries(
  userId: string,
  tz: string,
  since: Date,
): Promise<NamedSeries> {
  const medications = await prisma.medication.findMany({
    // PRN (as-needed) medications have no expected doses → no defensible rate.
    where: { userId, active: true, asNeeded: false, ...TRACKED_INTAKE_WHERE },
    include: {
      schedules: { select: SCHEDULE_COMPLIANCE_SELECT },
      scheduleRevisions: { orderBy: { validFrom: "asc" } },
      // v1.25 H-MED1 — pause eras so paused days drop out of the denominator.
      pauseEras: { select: { pausedAt: true, resumedAt: true } },
    },
    orderBy: { name: "asc" },
  });
  if (medications.length === 0) {
    return {
      key: MEDICATION_COMPLIANCE_CHANNEL_KEY,
      role: "behaviour",
      points: [],
    };
  }

  const events = await prisma.medicationIntakeEvent.findMany({
    where: {
      userId,
      deletedAt: null,
      medicationId: { in: medications.map((med) => med.id) },
      scheduledFor: { gte: since },
    },
    orderBy: { scheduledFor: "asc" },
    select: {
      medicationId: true,
      scheduledFor: true,
      takenAt: true,
      skipped: true,
    },
  });

  const now = new Date();
  const ledgerRows: DoseHistoryRow[] = [];
  for (const medication of medications) {
    const medEvents = events.filter((e) => e.medicationId === medication.id);
    const ctx = buildComplianceMedicationContext(
      medication,
      lastNonSkippedTakenAt(medEvents),
      tz,
    );
    const bundle = buildMedicationComplianceBundle(
      medEvents,
      medication.schedules,
      ctx,
      now,
    );
    ledgerRows.push(...bundle.ledgerRows);
  }

  return buildComplianceDailySeries(ledgerRows, tz);
}

/**
 * v1.21.0 (FDREXTEND) — build the user's SYMPTOM_SEVERITY daily series in the
 * `outcome` role (callers that need the behaviour role re-tag the returned
 * series — the points are role-invariant). Reads every in-window illness episode
 * + its day-logs; the builder zero-fills healthy days ONLY across real episode
 * spans, so a user with no episodes yields an empty series that degrades to
 * absent.
 */
export async function fetchSymptomSeries(
  userId: string,
  tz: string,
  since: Date,
): Promise<NamedSeries> {
  const now = new Date();
  const episodes = await prisma.illnessEpisode.findMany({
    // An episode overlaps the window when it onset before `now` and either is
    // ongoing or resolved at/after the window start.
    where: {
      userId,
      deletedAt: null,
      onsetAt: { lte: now },
      OR: [{ resolvedAt: null }, { resolvedAt: { gte: since } }],
    },
    select: { id: true, onsetAt: true, resolvedAt: true },
  });
  if (episodes.length === 0) {
    return { key: SYMPTOM_SEVERITY_CHANNEL_KEY, role: "outcome", points: [] };
  }

  const dayLogRows = await prisma.illnessDayLog.findMany({
    where: {
      userId,
      deletedAt: null,
      episodeId: { in: episodes.map((e) => e.id) },
    },
    select: {
      date: true,
      functionalImpact: true,
      symptomLinks: { select: { severity: true } },
    },
  });

  // Collapse each day-log to one burden value (functionalImpact, else the day's
  // max linked symptom severity) — the same rule the recovery-gap track uses.
  const dayLogs: SymptomDayLogRow[] = [];
  for (const row of dayLogRows) {
    if (row.functionalImpact != null) {
      dayLogs.push({ day: row.date, impact: row.functionalImpact });
      continue;
    }
    let maxSeverity: number | null = null;
    for (const link of row.symptomLinks) {
      if (link.severity == null) continue;
      maxSeverity =
        maxSeverity === null
          ? link.severity
          : Math.max(maxSeverity, link.severity);
    }
    if (maxSeverity != null)
      dayLogs.push({ day: row.date, impact: maxSeverity });
  }

  const spans: SymptomEpisodeSpan[] = episodes.map((e) => ({
    onsetAt: e.onsetAt,
    resolvedAt: e.resolvedAt,
  }));

  return buildSymptomSeverityDailySeries({
    dayLogs,
    episodes: spans,
    tz,
    windowStart: since,
    windowEnd: now,
    role: "outcome",
  });
}

/**
 * v1.25 (W-ENV) — build the user's environmental-exposure BEHAVIOUR channels.
 *
 * One {@link NamedSeries} per registered env field (temperature, daylight,
 * sunshine, precipitation, pressure mean + intraday swing), read from the daily
 * `EnvironmentContext` rows the nightly job stores. Each row's `date` is already
 * a YYYY-MM-DD key, so points need no re-keying. Sunshine / daylight are stored
 * in seconds and surfaced as hours (correlation r is scale-invariant; hours just
 * keep the series readable). A field with no non-null values yields an empty
 * series that degrades to absent — never a fabricated constant. The whole set is
 * empty when the user has no environment rows (module off / no home set).
 */
export async function fetchEnvironmentSeries(
  userId: string,
  since: Date,
): Promise<NamedSeries[]> {
  const sinceKey = since.toISOString().slice(0, 10);
  const rows = await prisma.environmentContext.findMany({
    where: { userId, date: { gte: sinceKey } },
    orderBy: { date: "asc" },
    take: 1000,
    select: {
      date: true,
      tempMean: true,
      tempMin: true,
      tempMax: true,
      apparentMean: true,
      sunshineSec: true,
      daylightSec: true,
      precipSum: true,
      pressureMean: true,
      pressureDelta: true,
      humidityMean: true,
      cloudMean: true,
    },
  });

  return ENVIRONMENT_FIELDS.map((field) => {
    const points: DailySeriesPoint[] = [];
    for (const row of rows) {
      const raw = row[field.column];
      if (raw == null || !Number.isFinite(raw)) continue;
      // Seconds → hours for the duration fields; pass through otherwise.
      const value =
        field.column === "sunshineSec" || field.column === "daylightSec"
          ? raw / 3600
          : raw;
      points.push({ day: row.date, value });
    }
    return { key: field.key, role: "behaviour" as const, points };
  });
}

/** Explicit deterministic ceiling on opt-in custom behaviour channels. */
export const MAX_CUSTOM_CORRELATION_CHANNELS = 8;
export const CUSTOM_METRIC_CHANNEL_PREFIX = "CUSTOM_METRIC:";

/**
 * Read only active, owner-scoped custom metrics that explicitly opted into
 * discovery. Metrics are selected oldest-first with an id tie-break and capped
 * before entries are read, bounding both channel count and pair-space growth.
 * Historical rows whose unit snapshot differs from the definition's current
 * unit are excluded so a rename/conversion can never mix units.
 */
export async function fetchCustomMetricBehaviourSeries(
  userId: string,
  tz: string,
  since: Date,
): Promise<NamedSeries[]> {
  const metrics = await prisma.customMetric.findMany({
    where: {
      userId,
      deletedAt: null,
      correlationEnabled: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: MAX_CUSTOM_CORRELATION_CHANNELS,
    select: {
      id: true,
      name: true,
      unit: true,
      entries: {
        // The parent metric's tombstone is filtered above; the entries' own
        // one has to be too, or a reading the person deleted keeps shaping
        // the correlation they are shown.
        where: { deletedAt: null, measuredAt: { gte: since } },
        orderBy: [{ measuredAt: "desc" }, { id: "desc" }],
        take: 2000,
        select: { value: true, unit: true, measuredAt: true },
      },
    },
  });

  return metrics.map((metric) => ({
    key: `${CUSTOM_METRIC_CHANNEL_PREFIX}${metric.id}`,
    label: metric.name,
    role: "behaviour" as const,
    points: toDailyMeans(
      metric.entries
        .filter((entry) => entry.unit === metric.unit)
        .map((entry) => ({ value: entry.value, at: entry.measuredAt })),
      tz,
    ),
  }));
}

/** Day key (YYYY-MM-DD) for an instant in the user's display timezone. */
function tzDayKey(at: Date, tz: string): string {
  const { year, month, day } = wallClockInTz(at, tz);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const MEASUREMENT_READ_CAP = 20000;
const MOOD_READ_CAP = 5000;

/** One measurement-window fetch's result: per-type raw rows + the cap flag. */
export interface MeasurementWindowFetch {
  /** Raw rows shaped for `buildMeasurementDailySeries`, grouped by type. */
  byType: Map<string, MeasurementSeriesRow[]>;
  /** True when the read hit the cap — the window may be missing OLDER rows. */
  measurementsCapped: boolean;
}

/**
 * v1.30.3 (QA F1/F2/F3) — shared measurement-window fetch for every
 * correlation-adjacent surface: the `/api/insights/correlations` route, the
 * Coach `get_correlations` tool, the per-metric assessment card, and the
 * period narrative. Hoisted here so a fourth independently-maintained copy
 * can't drift the way the period-narrative one did.
 *
 * Orders DESC + caps at {@link MEASUREMENT_READ_CAP}, then re-sorts ASC in
 * JS so a dense account's cap falls on the OLDEST rows, never the newest —
 * the inverse of a naive `orderBy asc, take N`, which silently drops the
 * NEWEST reads once an account's in-window row count crosses the cap
 * (exactly backwards for a recent-window read, e.g. the Coach's emerging-
 * correlations pass or a current-vs-prior period narrative). Selects
 * `source` / `deviceType` / `sleepStage` unconditionally so every caller can
 * feed `buildMeasurementDailySeries`'s per-type grain resolution (source
 * collapse for cumulative types, per-night reconstruction for sleep)
 * without a second query.
 */
export async function fetchMeasurementWindowSeries(
  userId: string,
  since: Date,
  types: MeasurementType[],
): Promise<MeasurementWindowFetch> {
  const rowsDesc = await prisma.measurement.findMany({
    where: {
      userId,
      deletedAt: null,
      measuredAt: { gte: since },
      type: { in: types },
    },
    orderBy: { measuredAt: "desc" },
    take: MEASUREMENT_READ_CAP,
    select: {
      type: true,
      value: true,
      measuredAt: true,
      source: true,
      deviceType: true,
      sleepStage: true,
    },
  });
  const measurementsCapped = rowsDesc.length >= MEASUREMENT_READ_CAP;

  const byType = new Map<string, MeasurementSeriesRow[]>();
  for (const m of [...rowsDesc].sort(
    (a, b) => a.measuredAt.getTime() - b.measuredAt.getTime(),
  )) {
    const list = byType.get(m.type) ?? [];
    list.push({
      value: m.value,
      at: m.measuredAt,
      source: m.source,
      deviceType: m.deviceType,
      sleepStage: m.sleepStage,
    });
    byType.set(m.type, list);
  }
  return { byType, measurementsCapped };
}

/** One mood-window fetch's result: the daily-mean series + the cap flag. */
export interface MoodWindowFetch {
  moodDaily: DailySeriesPoint[];
  /** True when the read hit the cap — the window may be missing OLDER rows. */
  moodCapped: boolean;
}

/**
 * v1.30.3 (QA F1/F2/F3) — shared mood-window fetch, same desc+cap+resort
 * discipline as {@link fetchMeasurementWindowSeries}. This helper covers the
 * plain-score case; the RATED-factor variant that also reads each entry's
 * tag-links is {@link fetchMoodFactorWindowSeries}, which carries the same
 * discipline over a wider select.
 */
export async function fetchMoodWindowSeries(
  userId: string,
  tz: string,
  since: Date,
): Promise<MoodWindowFetch> {
  const rowsDesc = await prisma.moodEntry.findMany({
    where: { userId, deletedAt: null, moodLoggedAt: { gte: since } },
    orderBy: { moodLoggedAt: "desc" },
    take: MOOD_READ_CAP,
    select: { score: true, moodLoggedAt: true },
  });
  const moodCapped = rowsDesc.length >= MOOD_READ_CAP;
  const rows = [...rowsDesc].sort(
    (a, b) => a.moodLoggedAt.getTime() - b.moodLoggedAt.getTime(),
  );
  const moodDaily = toDailyMeans(
    rows.map((e) => ({ value: e.score, at: e.moodLoggedAt })),
    tz,
  );
  return { moodDaily, moodCapped };
}

/** One mood-window fetch that also carries the RATED-factor channels. */
export interface MoodFactorWindowFetch extends MoodWindowFetch {
  /** One inverse-flipped daily-mean series per `FACTOR:<key>` channel. */
  factorSeries: Map<string, DailySeriesPoint[]>;
}

/**
 * A RATED mood factor link, carrying the scale + `inverse` flag so the
 * documented sign-flip is applied once, at the boundary.
 */
interface FactorLink {
  key: string;
  rating: number;
  scaleMin: number;
  scaleMax: number;
  inverse: boolean;
  at: Date;
}

/**
 * v1.14.0 — collapse RATED-factor links to one inverse-flipped daily-mean
 * series per factor, tz-day-keyed exactly like {@link toDailyMeans} so a factor
 * channel joins the discovery matrix on the same day grid as every vital.
 * An inverse factor's rating `r` maps to `(scaleMin + scaleMax) - r` BEFORE
 * averaging so "up" always reads as a better day — the same flip the mood
 * aggregates apply, kept in lock-step. Returns one `FACTOR:<key>` series per
 * factor the user actually rated. Pure.
 */
function factorDailyMeans(
  links: FactorLink[],
  tz: string,
): Map<string, DailySeriesPoint[]> {
  const byFactor = new Map<
    string,
    Map<string, { sum: number; count: number }>
  >();
  for (const l of links) {
    if (!Number.isFinite(l.rating)) continue;
    const value = l.inverse ? l.scaleMin + l.scaleMax - l.rating : l.rating;
    const day = tzDayKey(l.at, tz);
    const days =
      byFactor.get(l.key) ?? new Map<string, { sum: number; count: number }>();
    const acc = days.get(day) ?? { sum: 0, count: 0 };
    acc.sum += value;
    acc.count += 1;
    days.set(day, acc);
    byFactor.set(l.key, days);
  }
  const out = new Map<string, DailySeriesPoint[]>();
  for (const [key, days] of byFactor) {
    out.set(
      `${FACTOR_CHANNEL_PREFIX}${key}`,
      [...days.entries()]
        .map(([day, acc]) => ({ day, value: acc.sum / acc.count }))
        .sort((a, b) => (a.day < b.day ? -1 : 1)),
    );
  }
  return out;
}

/**
 * Mood-window fetch WITH the per-entry RATED-factor tag-links, for the one
 * surface that admits `FACTOR:*` channels into the discovery matrix (see the
 * `includeMoodFactors` option on `assembleDiscoveryMatrix` for why that is one
 * surface and not four). Same desc+cap+resort discipline as
 * {@link fetchMoodWindowSeries} over a wider select — the tag-links ride the
 * existing mood read, so this costs no extra round-trip over the plain variant.
 *
 * BINARY links carry a null `rating` and are excluded at the query.
 */
export async function fetchMoodFactorWindowSeries(
  userId: string,
  tz: string,
  since: Date,
): Promise<MoodFactorWindowFetch> {
  const rowsDesc = await prisma.moodEntry.findMany({
    where: { userId, deletedAt: null, moodLoggedAt: { gte: since } },
    orderBy: { moodLoggedAt: "desc" },
    take: MOOD_READ_CAP,
    select: {
      score: true,
      moodLoggedAt: true,
      tagLinks: {
        where: { moodTag: { kind: "RATED" }, rating: { not: null } },
        select: {
          rating: true,
          moodTag: {
            select: {
              key: true,
              scaleMin: true,
              scaleMax: true,
              inverse: true,
            },
          },
        },
      },
    },
  });
  const moodCapped = rowsDesc.length >= MOOD_READ_CAP;
  const rows = [...rowsDesc].sort(
    (a, b) => a.moodLoggedAt.getTime() - b.moodLoggedAt.getTime(),
  );
  const moodDaily = toDailyMeans(
    rows.map((e) => ({ value: e.score, at: e.moodLoggedAt })),
    tz,
  );

  const links: FactorLink[] = [];
  for (const entry of rows) {
    for (const link of entry.tagLinks) {
      if (link.rating == null) continue;
      links.push({
        key: link.moodTag.key,
        rating: link.rating,
        scaleMin: link.moodTag.scaleMin,
        scaleMax: link.moodTag.scaleMax,
        inverse: link.moodTag.inverse,
        at: entry.moodLoggedAt,
      });
    }
  }

  return { moodDaily, moodCapped, factorSeries: factorDailyMeans(links, tz) };
}

/**
 * v1.29.6 — collapse rows to per-day MEANS keyed in the user's tz. This is
 * the correct grain for spot metrics (BP, glucose, HRV, resting HR, weight,
 * mood) where a day's reduction is the average of its readings. Cumulative
 * metrics and sleep must NOT use this — see `buildMeasurementDailySeries`.
 *
 * Hoisted here from the two former call sites (`/api/insights/correlations`
 * and `metric-correlation-context.ts`) so both surfaces stay byte-identical
 * instead of drifting as two independently-maintained copies — the same
 * class of drift that let the cumulative/sleep grain bug below slip into
 * one file and not the other.
 */
export function toDailyMeans(
  rows: Array<{ value: number; at: Date }>,
  tz: string,
): DailySeriesPoint[] {
  const byDay = new Map<string, { sum: number; count: number }>();
  for (const r of rows) {
    if (!Number.isFinite(r.value)) continue;
    const day = tzDayKey(r.at, tz);
    const acc = byDay.get(day) ?? { sum: 0, count: 0 };
    acc.sum += r.value;
    acc.count += 1;
    byDay.set(day, acc);
  }
  return [...byDay.entries()]
    .map(([day, acc]) => ({ day, value: acc.sum / acc.count }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));
}

/** Minimum row shape `buildMeasurementDailySeries` needs per raw reading. */
export interface MeasurementSeriesRow {
  value: number;
  at: Date;
  source: MeasurementSource;
  deviceType: string | null;
  /** Only populated (and only consulted) for SLEEP_DURATION rows. */
  sleepStage: SleepStageRow["sleepStage"] | null;
}

/**
 * v1.29.6 — collapse one MeasurementType's raw rows to a single-grain daily
 * series, keyed in the user's tz. Fixes a correlation-discovery distortion:
 * `ACTIVITY_STEPS` and other cumulative HK types were being reduced with
 * `toDailyMeans`, which blends per-sample chunk averages (~350 steps, from
 * the not-yet-nightly-drained window) with drained `stats:` daily totals
 * (~8400 steps) into one meaningless per-day figure. `SLEEP_DURATION` was
 * averaging per-STAGE segment durations (~45 min) instead of summing a
 * night's total time asleep, and without collapsing overlapping sources
 * first (a WHOOP + Apple Health night double-counted).
 *
 *  - `SLEEP_DURATION` → per-night TOTAL time asleep for the MAIN session
 *    (naps excluded, matching the dashboard/list convention), via
 *    `reconstructSleepSessions` — the same writer-dedup + per-night
 *    collapse the sleep list route and dashboard tile use.
 *  - `CUMULATIVE_HK_TYPES` (steps, active energy, distance, flights,
 *    daylight, falls) → source-collapsed per-day SUM, via
 *    `pickCanonicalSourceRows` (a type with no ladder passes every row
 *    through unchanged, matching the picker's documented fallback).
 *  - everything else → per-day MEAN via `toDailyMeans` (unchanged).
 */
export function buildMeasurementDailySeries(
  type: MeasurementType,
  rows: MeasurementSeriesRow[],
  tz: string,
  priorityJson: unknown,
): DailySeriesPoint[] {
  if (type === "SLEEP_DURATION") {
    return buildSleepDailySeries(rows, tz, priorityJson);
  }
  if (CUMULATIVE_HK_TYPES.has(type)) {
    return buildCumulativeDailySeries(type, rows, tz, priorityJson);
  }
  return toDailyMeans(
    rows.map((r) => ({ value: r.value, at: r.at })),
    tz,
  );
}

function buildSleepDailySeries(
  rows: MeasurementSeriesRow[],
  tz: string,
  priorityJson: unknown,
): DailySeriesPoint[] {
  const stageRows: SleepStageRow[] = rows.map((r) => ({
    value: r.value,
    measuredAt: r.at,
    sleepStage: r.sleepStage,
    source: r.source,
    deviceType: r.deviceType,
  }));
  const sessions = reconstructSleepSessions(stageRows, tz, priorityJson);

  const byNight = new Map<string, typeof sessions>();
  for (const s of sessions) {
    const list = byNight.get(s.night) ?? [];
    list.push(s);
    byNight.set(s.night, list);
  }

  const points: DailySeriesPoint[] = [];
  for (const [night, nightSessions] of byNight) {
    const { main } = pickMainNightAndNaps(nightSessions);
    if (!main) continue;
    points.push({ day: night, value: main.asleepMinutes });
  }
  return points.sort((a, b) => (a.day < b.day ? -1 : 1));
}

function buildCumulativeDailySeries(
  type: MeasurementType,
  rows: MeasurementSeriesRow[],
  tz: string,
  priorityJson: unknown,
): DailySeriesPoint[] {
  const metricKey = metricKeyForType(type);
  const canonicalRows = metricKey
    ? pickCanonicalSourceRows(
        rows.map((r) => ({
          measuredAt: r.at,
          source: r.source,
          deviceType: r.deviceType,
          type,
          value: r.value,
        })),
        metricKey,
        priorityJson,
        (d) => tzDayKey(d, tz),
      ).canonicalRows
    : rows.map((r) => ({ measuredAt: r.at, value: r.value }));

  const byDay = new Map<string, number>();
  for (const row of canonicalRows) {
    if (!Number.isFinite(row.value)) continue;
    const key = tzDayKey(row.measuredAt, tz);
    byDay.set(key, (byDay.get(key) ?? 0) + row.value);
  }
  return [...byDay.entries()]
    .map(([day, value]) => ({ day, value }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));
}

/** One tiered measurement daily-series fetch's result. */
export interface TieredMeasurementDailySeries {
  /**
   * Per-type daily series, same shape `buildMeasurementDailySeries`
   * produces. A requested type with no data maps to an empty array or is
   * absent — callers treat both as "channel degrades to absent".
   */
  byType: Map<string, DailySeriesPoint[]>;
  /**
   * True when the RAW fallback read hit {@link MEASUREMENT_READ_CAP} —
   * rollup-served channels read one row per day per source and cannot cap,
   * so the flag now describes only the channels that took the raw path.
   */
  measurementsCapped: boolean;
  /** Channel types served from the DAY rollup tier on this call. */
  rollupTypes: MeasurementType[];
}

/**
 * True for the discovery measurement channels whose daily reduction the
 * DAY rollup tier can reproduce. Two families are structurally excluded:
 *
 *   - `SLEEP_DURATION` — the daily figure is the MAIN night's total asleep
 *     minutes via `reconstructSleepSessions` (writer-dedup, midnight-spanning
 *     session clustering, nap exclusion). A DAY bucket over per-STAGE rows
 *     carries none of that; no composition of `count/mean/sum` recovers it.
 *   - `CUMULATIVE_HK_TYPES` (steps, daylight, …) — the raw path collapses on
 *     TWO axes via `pickCanonicalSourceRows`: source ladder, then device-type
 *     ladder WITHIN the picked source (watch beats phone beats scale). Rollup
 *     rows are per `(day, source)` only — the device-type axis is folded away
 *     at write time, so a multi-device day would re-inflate the total the raw
 *     path deliberately de-duplicates.
 *
 * Both stay on the raw path rather than shipping a silent value change.
 */
function isRollupSwapEligible(type: MeasurementType): boolean {
  return type !== "SLEEP_DURATION" && !CUMULATIVE_HK_TYPES.has(type);
}

/**
 * Collapse per-`(day, source)` DAY rollup rows into per-day MEANS across
 * ALL sources — the exact reduction `toDailyMeans` applies to the raw
 * rows. Deliberately NOT `collapseRollupRowsBySource`: the raw spot-metric
 * path averages every reading of the day regardless of source, so the
 * ladder collapse would CHANGE a multi-source day's value. The
 * count-weighted compose (Σ sum / Σ count, preferring the exact stored
 * `sumValue` over the `mean·count` round trip) reproduces the all-rows
 * mean exactly up to float addition order.
 */
function composeRollupDailyMeans(
  rows: Array<{
    bucketStart: Date;
    count: number;
    mean: number;
    sumValue: number | null;
  }>,
): DailySeriesPoint[] {
  const byDay = new Map<string, { sum: number; count: number }>();
  for (const r of rows) {
    if (r.count <= 0) continue;
    const sum = r.sumValue ?? r.mean * r.count;
    if (!Number.isFinite(sum)) continue;
    // DAY buckets are minted at UTC midnight; the UTC date IS the bucket's
    // day key (the same convention graded-series and the derived baselines
    // read the tier under).
    const day = r.bucketStart.toISOString().slice(0, 10);
    const acc = byDay.get(day) ?? { sum: 0, count: 0 };
    acc.sum += sum;
    acc.count += r.count;
    byDay.set(day, acc);
  }
  return [...byDay.entries()]
    .map(([day, acc]) => ({ day, value: acc.sum / acc.count }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));
}

/**
 * Rollup read-swap for the correlation-discovery measurement channels: the
 * per-day means the discovery scan needs already sit in the DAY rollup
 * tier, so eligible spot channels read one pre-aggregated row per day per
 * source instead of every raw reading in the 180-day window (a CGM
 * glucose channel alone can hold tens of thousands of raw rows).
 *
 * Read-swap semantics (standing rule: replace, with fallback-on-miss —
 * never both): per channel, EITHER the rollup tier serves the series OR
 * the raw `fetchMeasurementWindowSeries` + `buildMeasurementDailySeries`
 * path does. A channel falls back when
 *   - the type is structurally ineligible ({@link isRollupSwapEligible}),
 *   - the user's profile timezone is outside the near-UTC band (below),
 *   - the coverage probe reports no DAY buckets for the type, or
 *   - the in-window bucket read comes back empty (backfill pending).
 *
 * Timezone contract — the same v1.4.38 W-A guard the correlation
 * hypotheses fast path carries: DAY buckets group rows by UTC day while
 * the raw path keys days in the profile tz. Inside the ±3 h `isNearUtc`
 * band the two calendars agree for every reading logged more than the
 * tz-offset away from local midnight; readings inside that band attribute
 * to the neighbouring day (the documented, accepted tolerance — the
 * n ≥ 20 / FDR gates absorb the single-day phase shift). Outside the band
 * the calendars diverge for most of the day, so the guard forces the raw
 * path and day-key parity is preserved exactly.
 *
 * Window contract: buckets are read `bucketStart >= since`, so the
 * partial OLDEST day (the one `since` lands inside) is not served — the
 * rollup series covers full days only, while the raw path would have
 * included that day's post-`since` readings. One day at the 180-day
 * horizon, equivalent to the user not logging that day.
 *
 * NOT `readBestGranularityRollups`: its floor table routes a >90-day
 * window to the WEEK tier first, which cannot feed a daily series — the
 * discovery scan needs the DAY grain unconditionally.
 */
export async function fetchMeasurementDailySeriesTiered(
  userId: string,
  tz: string,
  since: Date,
  types: MeasurementType[],
): Promise<TieredMeasurementDailySeries> {
  const priorityJson = await loadUserSourcePriority(userId);

  const rawTypes: MeasurementType[] = [];
  const rollupCandidates: MeasurementType[] = [];
  const nearUtc = isNearUtc(tz);
  for (const type of types) {
    if (nearUtc && isRollupSwapEligible(type)) rollupCandidates.push(type);
    else rawTypes.push(type);
  }

  const byType = new Map<string, DailySeriesPoint[]>();
  const rollupTypes: MeasurementType[] = [];

  if (rollupCandidates.length > 0) {
    const coverage = await probeRollupCoverage(userId);
    const covered: MeasurementType[] = [];
    for (const type of rollupCandidates) {
      if (coverage.get(type) === true) covered.push(type);
      else rawTypes.push(type);
    }
    if (covered.length > 0) {
      const buckets = await prisma.measurementRollup.findMany({
        where: {
          userId,
          type: { in: covered },
          granularity: "DAY",
          bucketStart: { gte: since },
        },
        orderBy: { bucketStart: "asc" },
        select: {
          type: true,
          bucketStart: true,
          count: true,
          mean: true,
          sumValue: true,
        },
      });
      const rowsByType = new Map<string, typeof buckets>();
      for (const bucket of buckets) {
        const list = rowsByType.get(bucket.type) ?? [];
        list.push(bucket);
        rowsByType.set(bucket.type, list);
      }
      for (const type of covered) {
        const series = composeRollupDailyMeans(rowsByType.get(type) ?? []);
        if (series.length === 0) {
          // Coverage said "has buckets" but the window resolved empty —
          // backfill pending or all data older than the window. Fall back
          // so a partially-backfilled account never reads a thinner series
          // than the raw path would produce.
          rawTypes.push(type);
        } else {
          byType.set(type, series);
          rollupTypes.push(type);
        }
      }
    }
  }

  let measurementsCapped = false;
  if (rawTypes.length > 0) {
    const rawFetch = await fetchMeasurementWindowSeries(
      userId,
      since,
      rawTypes,
    );
    measurementsCapped = rawFetch.measurementsCapped;
    for (const type of rawTypes) {
      byType.set(
        type,
        buildMeasurementDailySeries(
          type,
          rawFetch.byType.get(type) ?? [],
          tz,
          priorityJson,
        ),
      );
    }
  }

  return { byType, measurementsCapped, rollupTypes };
}

/**
 * v1.22 — build the user's lab draws for the labs ↔ outcome correlation pass.
 *
 * One {@link LabDrawPoint} per QUANTITATIVE reading in the window, keyed
 * `LAB:<canonical analyte>` (the resolved name, so two spellings of one marker
 * collapse). HIDDEN biomarkers are excluded (the W3 catalog `hidden` flag — a
 * marker the user retired from the active list must not silently re-enter an
 * analysis surface). Qualitative readings (no numeric `value`) and rows whose
 * resolved value is non-finite are dropped — there is nothing to correlate.
 * The encrypted note column is never selected.
 *
 * Returns an EMPTY array when the user has no usable readings, so the discovery
 * pass degrades to absent rather than fabricating a link.
 */
export async function fetchLabDraws(
  userId: string,
  tz: string,
  since: Date,
): Promise<LabDrawPoint[]> {
  const now = new Date();
  const rows = await prisma.labResult.findMany({
    where: {
      userId,
      deletedAt: null,
      value: { not: null },
      takenAt: { gte: since, lte: now },
    },
    orderBy: { takenAt: "asc" },
    take: 5000,
    select: {
      analyte: true,
      unit: true,
      referenceLow: true,
      referenceHigh: true,
      sourceReferenceLow: true,
      sourceReferenceHigh: true,
      sourceReferenceText: true,
      panel: true,
      value: true,
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

  const draws: LabDrawPoint[] = [];
  for (const row of rows) {
    // Exclude retired markers (W3 hidden flag); unlinked rows cannot be hidden.
    if (row.biomarker?.hidden) continue;
    if (row.value === null || !Number.isFinite(row.value)) continue;
    const resolved = resolveLabFields(row, row.biomarker);
    draws.push({
      key: `LAB:${resolved.analyte}`,
      day: tzDayKey(row.takenAt, tz),
      value: row.value,
    });
  }
  return draws;
}
