/**
 * GET /api/measurements/series?kind=&days=
 *
 * iOS-friendly time-series adapter. Maps the camelCase `kind` to the
 * canonical Prisma `MeasurementType`(s) and returns
 *   { kind, points: [{ id, at, value, secondary }], stats }
 *
 * The `kind=bloodPressure` case pairs systolic + diastolic by
 * `measuredAt` so iOS can render the dual-line chart with one fetch.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import {
  apiSuccess,
  buildPayloadDiagnostic,
  returnAllZodIssues,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { summarize, type DataPoint } from "@/lib/analytics/trends";
import { redactForExcerpt } from "@/lib/observability/redact-payload";
import type { MeasurementType, SleepStage } from "@/generated/prisma/client";
import { reconstructSleepNights } from "@/lib/analytics/sleep-night";
import { VALUE_RANGES } from "@/lib/validations/measurement";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { seriesRowsFrom } from "@/lib/measurements/series-canonical";
import { buildSourceRankCase } from "@/lib/analytics/source-rank-sql";
import { resolveUserTimezone, userDayKey } from "@/lib/tz/resolver";
import { convertGlucose, resolveGlucoseUnit } from "@/lib/glucose";

/**
 * v1.11.4 — sleep is read row-per-stage (not from the day rollup), so its
 * window is capped to one year even when the client requests the 3650-day
 * "Alle" range. Matches the slim slice's `withSleepNightTotals` sleep read.
 */
const SLEEP_SERIES_MAX_DAYS = 365;

/**
 * v1.28.25 — sample-dense kinds read raw rows only up to this window.
 * A CGM account stores ~288 BLOOD_GLUCOSE rows/day (105k+ rows/year) and
 * per-sample PULSE piles up similarly, so the 365 / 3650-day requests
 * walked a six-figure row set into JS, mapped it twice, and serialized
 * everything. Mirrors the sleep precedent above, but instead of silently
 * clamping the window, requests beyond the cap keep their full range and
 * are day-bucketed in SQL (one point per day, mean + min/max band) — the
 * chart still shows the whole requested history, just at daily grain.
 * The short windows users actually browse (7 / 30 / 90 d) stay raw and
 * byte-identical. Sparse kinds (weight, BP, …) are untouched.
 */
const DENSE_SERIES_RAW_WINDOW_DAYS = 90;
/**
 * The kinds a device can write at sampling rate. Heart-rate variability and
 * blood oxygen joined pulse and glucose once watches and rings began writing
 * them every few minutes overnight: their 3650-day "Alle" range read every
 * raw row, which is the read this rule exists to stop.
 */
const DENSE_SERIES_KINDS: ReadonlySet<string> = new Set([
  "glucose",
  "pulse",
  "heartRateVariability",
  "oxygenSaturation",
]);

/**
 * #1023 — inside the raw window, a dense-kind series (pulse, glucose, HRV,
 * blood oxygen) with more rows than this is bucketed per local hour in SQL
 * instead of sent raw.
 *
 * A watch that records heart rate once a minute puts 43 000 rows in the
 * default 30-day window and 130 000 in 90 days: a 15 MB response the client
 * could not draw at that resolution anyway, built from as many objects on the
 * server. A CGM reading every five minutes puts 26 000 glucose rows in 90
 * days, the same problem at a smaller scale. Hourly buckets carry the hour's
 * mean (pulse also its low/high band, the shape an hourly-bucket import
 * already has) and cap the answer at 24 points a day; the statistics stay
 * computed over every raw reading. The cap sits far above what sparse sources
 * produce (a cuff, fingerstick glucose, hourly buckets over 90 days, a watch
 * sampling every five minutes over 30 days), so those series stay raw and
 * unchanged.
 */
const DENSE_SERIES_RAW_ROW_CAP = 10_000;

const kindEnum = z.enum([
  "weight",
  "bloodPressure",
  "pulse",
  "bodyFat",
  "glucose",
  "sleep",
  "steps",
  "totalBodyWater",
  "boneMass",
  "oxygenSaturation",
  // v1.5.5 — the iOS app surfaces these as series-capable, but
  // the route used to reject the trend/detail view request with a
  // 422. The underlying MeasurementType enum already carries each
  // value; this list extends the camelCase wire shape so the route
  // matches the data it can serve.
  "restingHeartRate",
  "heartRateVariability",
  "vo2Max",
]);

const querySchema = z.object({
  kind: kindEnum,
  // v1.5.5 — the 365-day cap rejected the iOS app's "Alle"-range
  // request (days = 3650) with a 422, painting an error banner on
  // every metric tile. Ten years matches the recurrence engine's
  // nextOccurrenceAfter hard cap and the medication course-window
  // upper bound, so the ceiling stays consistent across the surface
  // area that the user can wire to a "show me everything" intent.
  days: z.coerce.number().int().min(1).max(3650).optional().default(30),
});

const KIND_TO_TYPE: Record<z.infer<typeof kindEnum>, MeasurementType> = {
  weight: "WEIGHT",
  bloodPressure: "BLOOD_PRESSURE_SYS",
  pulse: "PULSE",
  bodyFat: "BODY_FAT",
  glucose: "BLOOD_GLUCOSE",
  sleep: "SLEEP_DURATION",
  steps: "ACTIVITY_STEPS",
  totalBodyWater: "TOTAL_BODY_WATER",
  boneMass: "BONE_MASS",
  oxygenSaturation: "OXYGEN_SATURATION",
  restingHeartRate: "RESTING_HEART_RATE",
  heartRateVariability: "HEART_RATE_VARIABILITY",
  vo2Max: "VO2_MAX",
};

/**
 * v1.11.4 — explicit per-kind unit token returned at the top level so
 * the client never has to infer the value's unit. `bloodPressure` reuses
 * the systolic type's unit (mmHg, same for both lines). `sleep` is
 * overridden at request time to `"h"` because the route returns per-night
 * TIME-ASLEEP in hours rather than the canonical per-stage minutes.
 *
 * v1.16.16 — `glucose` is the canonical-stored unit (mg/dL) here; it is
 * overridden at request time to the user's `glucoseUnit` preference and the
 * point values are converted to match, so this wire DTO reads in the SAME
 * unit as the CSV + FHIR exports and the blood-glucose detail page (one
 * number, one engine).
 */
const SERIES_UNIT: Record<z.infer<typeof kindEnum>, string> = {
  weight: "kg",
  bloodPressure: "mmHg",
  pulse: "bpm",
  bodyFat: "%",
  glucose: "mg/dL",
  sleep: "h",
  steps: "steps",
  totalBodyWater: "kg",
  boneMass: "kg",
  oxygenSaturation: "%",
  restingHeartRate: "bpm",
  heartRateVariability: "ms",
  vo2Max: "mL/(kg·min)",
};

interface SeriesPoint {
  id: string;
  at: string;
  value: number;
  secondary: number | null;
  /**
   * v1.11.4 — per-stage minutes for a sleep night point. `null` for
   * every non-sleep kind. Lets a sleep detail view render the night's
   * stage breakdown without a second fetch; the headline `value` stays
   * the night's TIME-ASLEEP total.
   */
  sleepStages?: Partial<Record<SleepStage, number>> | null;
  /**
   * v1.19.2 (iOS #34 extension) — per-point spread for `kind=pulse`. On an
   * aggregated hourly heart-rate bucket `value` is the hour's AVERAGE bpm
   * and these carry the hour's MIN / MAX. `null` for a per-sample PULSE row
   * (no bucket spread) and absent for every non-pulse kind, so a client can
   * render a low/high band only where the data supports it.
   */
  valueMin?: number | null;
  valueMax?: number | null;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.round(Math.sqrt(variance) * 100) / 100;
}

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("read", "measurements");

  const rawQuery = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = querySchema.safeParse(rawQuery);
  if (!parsed.success) {
    // v1.4.43 W6 — iOS chart loader hot path; multi-issue 422 +
    // audit breadcrumb keyed `measurements.series.validation-failed`.
    const issues = sanitiseZodIssues(parsed.error.issues);
    // v1.4.48 H-iOS-2 — surface the iOS-sent query shape alongside
    // the Zod rejection. Top-level keys + a hard 256-char JSON excerpt
    // only; never the full payload, so token-shaped query params (we
    // do not currently accept any but the truncation keeps that
    // invariant cheap) cannot leak. Shared helper via v1.4.49 so the
    // widget + series routes can't drift on the diagnostic shape; the
    // query map is routed through `redactForExcerpt` first so any
    // future credential-shaped query string (`token`, `apiKey`,
    // `csrfState`) redacts to `"[redacted]"` before the truncate.
    const payloadDiagnostic = buildPayloadDiagnostic(
      redactForExcerpt(rawQuery),
    );
    annotate({
      action: { name: "measurements.series.validation-failed" },
      meta: {
        issue_count: issues.length,
        ...payloadDiagnostic,
        zod_issues: issues,
      },
    });
    // v1.4.49 — strip `message` from the audit-ledger row so Zod
    // codes that embed the offending value (`invalid_enum_value` etc.)
    // cannot leak user content through the audit surface.
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    // v1.36.0 — through `auditLog()` rather than a bare `prisma.auditLog
    // .create`, because that helper is the only thing that stamps
    // `actorUserId`. Filed under the resolved record either way; without the
    // stamp a delegate's malformed query would read as the owner's own.
    void auditLog("measurements.series.validation-failed", {
      userId: user.id,
      details: { issues: auditIssues },
    }).catch(() => {
      /* swallow — 422 response is the contract */
    });
    return returnAllZodIssues(parsed.error, 422);
  }

  const { kind, days } = parsed.data;
  const since = new Date(Date.now() - days * 86_400_000);

  // v1.11.4 — explicit unit token so the client never infers the unit
  // from the kind. Sleep is special-cased below (per-night TIME-ASLEEP
  // in HOURS); every other kind carries its canonical stored unit.
  let unit = SERIES_UNIT[kind];

  let points: SeriesPoint[] = [];
  // v1.16.16 — when glucose stats are computed over RAW mg/dL (parity with the
  // detail page + FHIR), the branch fills this so the response below skips the
  // generic over-points path that would double-round mmol/L figures.
  // v1.28.25 — the dense day-bucket branch also fills it (stats stay
  // aggregated over the RAW rows in SQL, not over the day-bucket points).
  let statsOverride: {
    mean: number;
    min: number;
    max: number;
    stdDev: number;
    count: number;
  } | null = null;
  if (kind === "sleep") {
    // SLEEP_DURATION is stored one row per STAGE per night (minutes).
    // Collapse the stage rows into ONE point per night carrying the
    // night's TIME ASLEEP (CORE + DEEP + REM, excluding IN_BED + AWAKE),
    // converted to HOURS. The single-stage rows the legacy path returned
    // made the chart show one fragment per stage instead of a nightly
    // trend. The per-night reconstruction clusters stages into sessions
    // (so a midnight-spanning night stays one point) and collapses a
    // dual-source night to one canonical source via the user's `sleep`
    // priority ladder.
    //
    // v1.11.4 — sleep is the one kind read row-per-stage (≈5 rows/night ×
    // source-count) rather than from the day-bucketed rollup, so an
    // unbounded "Alle" (days = 3650) request on a multi-year dual-source
    // account would walk a six-figure row set into JS. Cap the sleep read
    // at SLEEP_SERIES_MAX_DAYS (365 d) — the same one-year bound the slim
    // slice's `withSleepNightTotals` uses — so the window stays small
    // regardless of the requested range. Other kinds read from the rollup
    // tier and keep the full 3650-day range.
    const sleepSince = new Date(
      Date.now() - Math.min(days, SLEEP_SERIES_MAX_DAYS) * 86_400_000,
    );
    const [tz, priorityJson] = await Promise.all([
      resolveUserTimezone(user.id),
      loadUserSourcePriority(user.id),
    ]);
    const rows = await prisma.measurement.findMany({
      where: {
        userId: user.id,
        type: "SLEEP_DURATION",
        measuredAt: { gte: sleepSince },
        deletedAt: null,
      },
      orderBy: { measuredAt: "asc" },
      select: {
        id: true,
        value: true,
        measuredAt: true,
        sleepStage: true,
        source: true,
        // Writer-level collapse: two HealthKit apps behind one source
        // (watch stages vs phone in-bed) must not blend into one night.
        deviceType: true,
      },
    });
    unit = "h";
    points = reconstructSleepNights(rows, tz, priorityJson)
      .filter((n) => n.asleepMinutes > 0)
      .map((n) => {
        const stageHours = Object.fromEntries(
          Object.entries(n.stages).map(([s, m]) => [
            s,
            Math.round((m / 60) * 100) / 100,
          ]),
        ) as Partial<Record<SleepStage, number>>;
        return {
          id: `sleep:${n.night}`,
          at: n.measuredAt.toISOString(),
          value: Math.round((n.asleepMinutes / 60) * 100) / 100,
          secondary: null,
          sleepStages: Object.keys(stageHours).length > 0 ? stageHours : null,
        };
      });
  } else if (kind === "bloodPressure") {
    // Exclude non-physiological rows (systolic < 40 / diastolic < 20) from the
    // series AND the implicit "latest" (the last point). BP is two rows paired
    // client-side, so a corrupt row that slipped in before the input floor was
    // enforced — a seed-era systolic-0, iOS #33 — must never surface as the
    // latest reading. Floors mirror VALUE_RANGES (the input validator's min);
    // this is a read-side selection guard, not a tightening of the write floor.
    //
    // The ladder picks ONE source per day for the reading, not one per type:
    // the source is chosen from the day's systolic rows that pass the floor,
    // and both halves are read from it. Two per-type picks diverge whenever a
    // source holds only half of a reading on a day (a deleted diastolic, a
    // sub-floor systolic, an orphaned sample), and the pairing below then
    // joined one source's systolic to another source's diastolic. Picking on
    // floor-passing systolic rows also keeps a corrupt row from claiming a day
    // it then contributes nothing to. The day is the UTC day, as in every
    // other ladder read (`canonicalMeasurementsCte`), and the pick looks at
    // the whole edge day, not only the slice after `since`.
    //
    // `rank` is the closed-enum whitelist splice from `buildSourceRankCase`;
    // every request value is a positional parameter.
    const rank = buildSourceRankCase(
      await loadUserSourcePriority(user.id),
      '"type"',
      '"source"',
    );
    const bpRows = await prisma.$queryRawUnsafe<
      Array<{
        id: string;
        type: "BLOOD_PRESSURE_SYS" | "BLOOD_PRESSURE_DIA";
        source: string;
        value: number;
        measured_at: Date;
      }>
    >(
      `
      SELECT m."id", m."type"::text AS type, m."source"::text AS source,
             m."value", m."measured_at"
      FROM measurements m
      JOIN (
        SELECT DISTINCT ON (date_trunc('day', "measured_at"))
          date_trunc('day', "measured_at") AS d,
          "source"                         AS canon
        FROM measurements
        WHERE "user_id" = $1
          AND "type" = 'BLOOD_PRESSURE_SYS'::"measurement_type"
          AND "deleted_at" IS NULL
          AND "value" >= $3
          AND "measured_at" >= date_trunc('day', $2::timestamptz)
        ORDER BY date_trunc('day', "measured_at"), (${rank}), "source"::text
      ) c
        ON c.d = date_trunc('day', m."measured_at")
        AND c.canon = m."source"
      WHERE m."user_id" = $1
        AND m."deleted_at" IS NULL
        AND m."measured_at" >= $2
        AND (
          (m."type" = 'BLOOD_PRESSURE_SYS'::"measurement_type" AND m."value" >= $3)
          OR (m."type" = 'BLOOD_PRESSURE_DIA'::"measurement_type" AND m."value" >= $4)
        )
      ORDER BY m."measured_at" ASC, m."id" ASC
    `,
      user.id,
      since,
      VALUE_RANGES.BLOOD_PRESSURE_SYS.min,
      VALUE_RANGES.BLOOD_PRESSURE_DIA.min,
    );
    const sys = bpRows.filter((r) => r.type === "BLOOD_PRESSURE_SYS");
    // Diastolic rows per source: a pair is only ever made inside one source,
    // which also holds across midnight, where the two days may have picked
    // different sources.
    const diaBySource = new Map<string, typeof bpRows>();
    for (const r of bpRows) {
      if (r.type !== "BLOOD_PRESSURE_DIA") continue;
      const list = diaBySource.get(r.source);
      if (list) list.push(r);
      else diaBySource.set(r.source, [r]);
    }

    // Pair by closest timestamp within ±5 minutes. Both reads arrive
    // sorted ascending, so the nearest-diastolic index is non-decreasing
    // across the systolic walk — a two-pointer merge (one pointer per
    // source) finds each pair in O(sys + dia) instead of the previous full
    // diastolic rescan per systolic row (O(sys × dia) — quadratic on dense
    // imports). Ties keep the earlier diastolic row, matching the old
    // scan's strict-`<` keep.
    const PAIR_WINDOW_MS = 5 * 60_000;
    const diaIdx = new Map<string, number>();
    points = sys.map((s) => {
      const sysMs = s.measured_at.getTime();
      const dia = diaBySource.get(s.source) ?? [];
      let idx = diaIdx.get(s.source) ?? 0;
      while (
        idx + 1 < dia.length &&
        Math.abs(dia[idx + 1].measured_at.getTime() - sysMs) <
          Math.abs(dia[idx].measured_at.getTime() - sysMs)
      ) {
        idx += 1;
      }
      diaIdx.set(s.source, idx);
      const best = dia[idx];
      const paired =
        best !== undefined &&
        Math.abs(best.measured_at.getTime() - sysMs) <= PAIR_WINDOW_MS;
      return {
        id: s.id,
        at: s.measured_at.toISOString(),
        value: s.value,
        secondary: paired ? best.value : null,
      };
    });
  } else if (
    (DENSE_SERIES_KINDS.has(kind) && days > DENSE_SERIES_RAW_WINDOW_DAYS) ||
    (DENSE_SERIES_KINDS.has(kind) &&
      (await prisma.measurement.count({
        where: {
          userId: user.id,
          type: KIND_TO_TYPE[kind],
          measuredAt: { gte: since },
          deletedAt: null,
        },
      })) > DENSE_SERIES_RAW_ROW_CAP)
  ) {
    // Day buckets past the raw window; hour buckets for a dense-kind
    // stream too dense to send raw inside it.
    const grain = days > DENSE_SERIES_RAW_WINDOW_DAYS ? "day" : "hour";
    // v1.28.25 — long-window read of a sample-dense kind (CGM glucose,
    // per-sample / hourly pulse). Day-bucket in SQL instead of walking
    // every raw row into JS: one aggregate pass in Postgres returns at
    // most `days` rows regardless of sample density. Bound parameters
    // mirror the rollup tier's `date_trunc(... ) GROUP BY` aggregate
    // (measurement-rollups.ts), and the rows are the ladder-winning source per
    // day, the same rule the rollup tier and sleep apply.
    const [userTz, priorityJson] = await Promise.all([
      resolveUserTimezone(user.id),
      loadUserSourcePriority(user.id),
    ]);
    const type = KIND_TO_TYPE[kind];
    const seriesRows = seriesRowsFrom(priorityJson, type, days);
    const bucketRows = await prisma.$queryRawUnsafe<
      Array<{
        bucket_start: Date;
        mean: number;
        min_value: number;
        max_value: number;
      }>
    >(
      `
      WITH localized AS (
        SELECT
          m."value",
          m."value_min",
          m."value_max",
          date_trunc(
            $2,
            (m."measured_at" AT TIME ZONE 'UTC') AT TIME ZONE $3
          ) AS local_day
        FROM ${seriesRows}
        WHERE m."measured_at" >= $4
      )
      SELECT
        local_day AT TIME ZONE $3                                AS bucket_start,
        AVG("value")::double precision                           AS mean,
        MIN(COALESCE("value_min", "value"))::double precision    AS min_value,
        MAX(COALESCE("value_max", "value"))::double precision    AS max_value
      FROM localized
      GROUP BY local_day
      ORDER BY bucket_start ASC
    `,
      user.id,
      grain,
      userTz,
      since,
    );
    // Stats stay aggregated over the RAW rows (not the day buckets) so the
    // strip's mean/min/max/stdDev/count are the same figures the raw path
    // computed: `AVG`/`MIN`/`MAX` over `value`, `STDDEV_POP` matching the
    // JS population-variance helper, exact row count. Aggregate-only —
    // no row transfer.
    const [rawAgg] = await prisma.$queryRawUnsafe<
      Array<{
        n: number;
        mean: number | null;
        min: number | null;
        max: number | null;
        sd: number | null;
      }>
    >(
      `
      SELECT
        COUNT(*)::int                            AS n,
        AVG(m."value")::double precision         AS mean,
        MIN(m."value")::double precision         AS min,
        MAX(m."value")::double precision         AS max,
        STDDEV_POP(m."value")::double precision  AS sd
      FROM ${seriesRows}
      WHERE m."measured_at" >= $2
    `,
      user.id,
      since,
    );
    const round2 = (v: number) => Math.round(v * 100) / 100;
    const dayId = (d: Date) =>
      grain === "day"
        ? `day:${userDayKey(d, userTz)}`
        : `hour:${d.toISOString()}`;
    if (kind === "glucose") {
      // Same unit engine as the raw glucose branch: canonical mg/dL in
      // the DB, converted ONCE at serialization to the user's preference.
      const profile = await prisma.user.findUnique({
        where: { id: user.id },
        select: { glucoseUnit: true },
      });
      const glucoseUnit = resolveGlucoseUnit(profile?.glucoseUnit ?? null);
      unit = glucoseUnit;
      points = bucketRows.map((r) => ({
        id: dayId(r.bucket_start),
        at: r.bucket_start.toISOString(),
        value: convertGlucose(r.mean, glucoseUnit),
        secondary: null,
      }));
      if (
        rawAgg !== undefined &&
        rawAgg.n > 0 &&
        rawAgg.mean !== null &&
        rawAgg.min !== null &&
        rawAgg.max !== null
      ) {
        // Mirrors the raw branch's v1.16.16 parity: round the mg/dL
        // aggregate to 2 decimals (summarize()'s convention), then
        // convert each figure once.
        statsOverride = {
          mean: convertGlucose(round2(rawAgg.mean), glucoseUnit),
          min: convertGlucose(rawAgg.min, glucoseUnit),
          max: convertGlucose(rawAgg.max, glucoseUnit),
          stdDev: convertGlucose(round2(rawAgg.sd ?? 0), glucoseUnit),
          count: rawAgg.n,
        };
      }
    } else {
      // `value` is the bucket's average. For pulse, valueMin/valueMax carry
      // the bucket's low/high band (folding each hourly import bucket's own
      // spread via the COALESCE above), same band semantics as the per-hour
      // shape. The other dense kinds keep the bare point shape their raw rows
      // have, so a client reads a bucket the way it reads a reading.
      points = bucketRows.map((r) => ({
        id: dayId(r.bucket_start),
        at: r.bucket_start.toISOString(),
        value: round2(r.mean),
        secondary: null,
        ...(kind === "pulse"
          ? { valueMin: r.min_value, valueMax: r.max_value }
          : {}),
      }));
      if (
        rawAgg !== undefined &&
        rawAgg.n > 0 &&
        rawAgg.mean !== null &&
        rawAgg.min !== null &&
        rawAgg.max !== null
      ) {
        statsOverride = {
          mean: round2(rawAgg.mean),
          min: rawAgg.min,
          max: rawAgg.max,
          stdDev: round2(rawAgg.sd ?? 0),
          count: rawAgg.n,
        };
      }
    }
  } else {
    const type = KIND_TO_TYPE[kind];
    // v1.19.2 (iOS #34 extension) — pull the per-bucket spread for the
    // heart-rate kind so the chart can render a low/high band around the
    // hourly average. Only PULSE rows ever carry a non-null spread (the
    // hourly HR bucket); every other kind selects the bare value shape.
    const includeSpread = kind === "pulse";
    // The ladder-winning source per day (see `seriesRowsFrom`), so a second
    // provider neither blends into nor duplicates the series. Bounded as before:
    // every dense kind reaches this read only inside 90 days and under 10 000
    // rows (counted first), and the sparse kinds are a few readings a day.
    const sourcePriority = await loadUserSourcePriority(user.id);
    const rawRows = await prisma.$queryRawUnsafe<
      Array<{
        id: string;
        value: number;
        measured_at: Date;
        value_min: number | null;
        value_max: number | null;
      }>
    >(
      `
      SELECT m."id", m."value", m."measured_at", m."value_min", m."value_max"
      FROM ${seriesRowsFrom(sourcePriority, type, days)}
      WHERE m."measured_at" >= $2
      ORDER BY m."measured_at" ASC, m."id" ASC
    `,
      user.id,
      since,
    );
    const rows = rawRows.map((r) => ({
      id: r.id,
      value: r.value,
      measuredAt: r.measured_at,
      ...(includeSpread
        ? { valueMin: r.value_min, valueMax: r.value_max }
        : {}),
    }));
    if (kind === "glucose") {
      // v1.16.16 — glucose is stored canonical mg/dL; convert each point to
      // the user's display unit AT SERIALIZATION so the wire DTO is unit-
      // coherent with the CSV + FHIR exports (one number, one engine). The
      // top-level `unit` token follows. mg/dL-preference users are unchanged
      // (convertGlucose rounds the integer); mmol/L users see 1-decimal
      // values (100 → 5.5) and `unit: "mmol/L"`.
      const profile = await prisma.user.findUnique({
        where: { id: user.id },
        select: { glucoseUnit: true },
      });
      const glucoseUnit = resolveGlucoseUnit(profile?.glucoseUnit ?? null);
      unit = glucoseUnit;
      points = rows.map((r) => ({
        id: r.id,
        at: r.measuredAt.toISOString(),
        value: convertGlucose(r.value, glucoseUnit),
        secondary: null,
      }));
      // v1.16.16 — stat parity. The stat strip's mean/min/max/stdDev must
      // match the detail-page + FHIR convention: aggregate over RAW mg/dL,
      // then convert each resulting figure ONCE. Deriving the stats from the
      // already-converted+rounded points double-rounds the mean and stdDev
      // for mmol/L users, drifting the last decimal off the detail page.
      // Single-reading sets stay identical (100 → 5.5). Hand back stats here
      // so the shared block below leaves a populated `statsOverride` alone.
      const rawDataPoints: DataPoint[] = rows.map((r) => ({
        date: r.measuredAt,
        value: r.value,
      }));
      if (rawDataPoints.length > 0) {
        const rawSummary = summarize(rawDataPoints);
        const rawValues = rawDataPoints.map((p) => p.value);
        statsOverride = {
          mean:
            rawSummary.mean === null
              ? 0
              : convertGlucose(rawSummary.mean, glucoseUnit),
          min:
            rawSummary.min === null
              ? 0
              : convertGlucose(rawSummary.min, glucoseUnit),
          max:
            rawSummary.max === null
              ? 0
              : convertGlucose(rawSummary.max, glucoseUnit),
          // Glucose mg/dL↔mmol/L is purely multiplicative (no offset), so a
          // spread converts with the same factor as a level.
          stdDev: convertGlucose(stdDev(rawValues), glucoseUnit),
          count: rawSummary.count,
        };
      }
    } else if (includeSpread) {
      // v1.19.2 (iOS #34 extension) — pulse points carry the per-bucket
      // spread. A per-sample PULSE row has null min/max; an hourly HR bucket
      // carries the hour's range around the average.
      points = rows.map((r) => {
        const row = r as typeof r & {
          valueMin: number | null;
          valueMax: number | null;
        };
        return {
          id: row.id,
          at: row.measuredAt.toISOString(),
          value: row.value,
          secondary: null,
          valueMin: row.valueMin ?? null,
          valueMax: row.valueMax ?? null,
        };
      });
    } else {
      points = rows.map((r) => ({
        id: r.id,
        at: r.measuredAt.toISOString(),
        value: r.value,
        secondary: null,
      }));
    }
  }

  const dataPoints: DataPoint[] = points.map((p) => ({
    date: new Date(p.at),
    value: p.value,
  }));
  const summary = dataPoints.length > 0 ? summarize(dataPoints) : null;
  const values = dataPoints.map((p) => p.value);

  annotate({
    action: { name: "measurements.series" },
    meta: { kind, days, count: points.length },
  });

  return apiSuccess({
    kind,
    unit,
    points,
    stats:
      statsOverride ??
      (summary
        ? {
            mean: summary.mean,
            min: summary.min,
            max: summary.max,
            stdDev: stdDev(values),
            count: summary.count,
          }
        : { mean: 0, min: 0, max: 0, stdDev: 0, count: 0 }),
  });
});
