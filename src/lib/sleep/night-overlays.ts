/**
 * The night metrics drawn as lines over the hypnogram (#1419), read for one
 * night and resolved on the server so every client draws the same thing.
 *
 * What a night holds differs by source. A watch or a ring writes pulse every
 * few seconds to every few minutes, an iPhone relays a handful of HRV,
 * breathing and SpO2 samples a night, and Garmin, Oura or WHOOP report one
 * average per night. A line needs a series; one value a night is served as a
 * `nightValue` and drawn as a number, never as a made-up curve.
 *
 * The read:
 *   - covers the session from 15 minutes before its first stage to 15 minutes
 *     after its last, so a line does not stop short of the edges;
 *   - folds the readings into buckets of five minutes (wider for a session
 *     long enough to pass {@link MAX_POINTS}) in Postgres, one row per bucket,
 *     type and source, so a stream of 35 000 pulse rows a day costs the same
 *     as a few samples;
 *   - adds, for the kinds that come as one value a night, the rows stamped on
 *     the wake day's daily anchor (local noon, `canonicalDailyTimestamp`),
 *     where Garmin's HRV and Oura's nightly SpO2 and temperature sit;
 *   - leaves out the day totals of the `stats:<HK>:<YYYY-MM-DD>` form, which
 *     stand for a whole day, not a moment of the night. The uploaded
 *     ten-minute buckets and the folded hours of an older night stay in.
 *
 * One source per metric, never two in one line: a series beats a single
 * value; among either, the source that recorded the night drawn comes first
 * (the source-family rule of #1485: a night from Apple Health gets Apple
 * Health's pulse), then the user's ladder for the type, then the source name.
 * HRV and skin temperature have two types each; a line never mixes them, and
 * the metric says which one it is.
 *
 * Every value is a bound parameter. One statement per night.
 */
import {
  Prisma,
  type MeasurementSource,
  type MeasurementType,
} from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { isModuleEnabled } from "@/lib/modules/gate";
import { moduleForMeasurementType } from "@/lib/modules/measurement-scope";
import { metricKeyForType } from "@/lib/measurements/cumulative-day-sum";
import { getUnitForType } from "@/lib/measurements/unit-map";
import { canonicalDailyTimestamp } from "@/lib/measurements/consolidation-tz";
import {
  getSourceLadder,
  parseSourcePriority,
} from "@/lib/validations/source-priority";
import {
  NIGHT_OVERLAY_KINDS,
  type NightOverlayKind,
} from "@/lib/sleep/night-overlay-kinds";

/** Lead and trail around the session, so a line reaches the chart's edges. */
export const OVERLAY_PADDING_MS = 15 * 60_000;
/** The narrowest bucket. */
const BASE_BUCKET_MINUTES = 5;
/** Most buckets a line holds; a longer session widens its buckets. */
export const MAX_POINTS = 288;

/**
 * A day total keyed `stats:<identifier>:<YYYY-MM-DD>`. Bound as a parameter
 * and matched with `~` in Postgres.
 */
const DAY_TOTAL_EXTERNAL_ID = "^stats:[^:]+:[0-9]{4}-[0-9]{2}-[0-9]{2}$";

interface KindSpec {
  /** The types that can carry the kind, tie order first. */
  types: readonly MeasurementType[];
  /**
   * Whether a single reading a night is worth showing as the night's value.
   * A lone pulse reading or room temperature reading says nothing about the
   * night, so those kinds draw a series or nothing.
   */
  nightValue: boolean;
}

export const OVERLAY_KIND_SPECS: Record<NightOverlayKind, KindSpec> = {
  pulse: { types: ["PULSE"], nightValue: false },
  hrv: { types: ["HEART_RATE_VARIABILITY", "HRV_RMSSD"], nightValue: true },
  respiration: { types: ["RESPIRATORY_RATE"], nightValue: true },
  spo2: { types: ["OXYGEN_SATURATION"], nightValue: true },
  skinTemperature: {
    types: ["WRIST_TEMPERATURE", "BODY_TEMPERATURE_DEVIATION"],
    nightValue: true,
  },
  roomTemperature: { types: ["INDOOR_TEMPERATURE"], nightValue: false },
};

/** The session the overlays are read for. */
export interface OverlaySession {
  /** Wake-day key, `YYYY-MM-DD`, in `timeZone`. */
  night: string;
  /** The zone the night is read in. */
  timeZone: string;
  source: MeasurementSource | null;
  start: Date;
  end: Date;
}

export interface NightOverlayPoint {
  /** Bucket start, ISO. Every line shares the grid from `from`. */
  at: string;
  /** Mean of the bucket's readings. */
  value: number;
  min: number;
  max: number;
}

export interface NightOverlayMetric {
  kind: NightOverlayKind;
  type: MeasurementType;
  /** Canonical unit token of `type` (`getUnitForType`). */
  unit: string;
  source: MeasurementSource;
  /** The series, ascending; empty when the night holds one value. */
  points: NightOverlayPoint[];
  /** The night's one value when there is no series; null otherwise. */
  nightValue: number | null;
  /** Over the readings inside the session; null without a series. */
  summary: { min: number; max: number; avg: number } | null;
}

export interface NightOverlays {
  /** The grid's origin: the session start less the padding, ISO. */
  from: string;
  /** The grid's end: the session end plus the padding, ISO. */
  to: string;
  bucketMinutes: number;
  /** One entry per kind the night holds, in `NIGHT_OVERLAY_KINDS` order. */
  metrics: NightOverlayMetric[];
}

/** One folded row of the read. `idx` null: a row on the daily anchor. */
export interface OverlayBucketRow {
  type: MeasurementType;
  source: MeasurementSource;
  idx: number | null;
  n: number;
  sum: number;
  min: number;
  max: number;
}

export interface OverlayGrid {
  originMs: number;
  endMs: number;
  bucketMs: number;
  /** Bucket indexes that lie inside the session itself. */
  firstSessionIdx: number;
  lastSessionIdx: number;
}

export function overlayGrid(start: Date, end: Date): OverlayGrid {
  const originMs = start.getTime() - OVERLAY_PADDING_MS;
  const endMs = end.getTime() + OVERLAY_PADDING_MS;
  const spanMinutes = Math.max(1, (endMs - originMs) / 60_000);
  const bucketMinutes =
    BASE_BUCKET_MINUTES *
    Math.max(1, Math.ceil(spanMinutes / (BASE_BUCKET_MINUTES * MAX_POINTS)));
  const bucketMs = bucketMinutes * 60_000;
  return {
    originMs,
    endMs,
    bucketMs,
    firstSessionIdx: Math.floor(OVERLAY_PADDING_MS / bucketMs),
    lastSessionIdx: Math.floor((end.getTime() - originMs) / bucketMs),
  };
}

/**
 * The statement {@link readNightOverlays} sends, exported so a plan check
 * can `EXPLAIN` exactly what the reader runs. Both arms bound the index on
 * `(user_id, type, measured_at)`.
 */
export function nightOverlaysSql(opts: {
  userId: string;
  types: readonly MeasurementType[];
  anchorTypes: readonly MeasurementType[];
  grid: OverlayGrid;
  anchor: Date;
}): Prisma.Sql {
  const { grid } = opts;
  const from = new Date(grid.originMs);
  const to = new Date(grid.endMs);
  const typeList = (types: readonly MeasurementType[]) =>
    Prisma.join(types.map((t) => Prisma.sql`${t}::measurement_type`));
  const anchorArm =
    opts.anchorTypes.length > 0
      ? Prisma.sql`
      UNION ALL
      SELECT m."type"::text AS type, m."source"::text AS source,
        NULL::int AS idx, m."value" AS value
      FROM measurements m
      WHERE m."user_id" = ${opts.userId}
        AND m."type" IN (${typeList(opts.anchorTypes)})
        AND m."deleted_at" IS NULL
        AND m."measured_at" = ${opts.anchor}
        AND NOT (m."measured_at" >= ${from} AND m."measured_at" < ${to})`
      : Prisma.empty;
  return Prisma.sql`
    WITH src AS (
      SELECT m."type"::text AS type, m."source"::text AS source,
        FLOOR(
          (EXTRACT(EPOCH FROM m."measured_at")::double precision * 1000
            - ${grid.originMs}::double precision)
          / ${grid.bucketMs}::double precision
        )::int AS idx,
        m."value" AS value
      FROM measurements m
      WHERE m."user_id" = ${opts.userId}
        AND m."type" IN (${typeList(opts.types)})
        AND m."deleted_at" IS NULL
        AND m."measured_at" >= ${from}
        AND m."measured_at" < ${to}
        AND (m."external_id" IS NULL OR m."external_id" !~ ${DAY_TOTAL_EXTERNAL_ID})
      ${anchorArm}
    )
    SELECT
      type,
      source,
      idx,
      COUNT(*)::int                AS n,
      SUM(value)::double precision AS sum,
      MIN(value)::double precision AS min_value,
      MAX(value)::double precision AS max_value
    FROM src
    GROUP BY type, source, idx
    ORDER BY type, source, idx ASC NULLS LAST
  `;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

interface Candidate {
  type: MeasurementType;
  source: MeasurementSource;
  /** In-window buckets, ascending. */
  buckets: OverlayBucketRow[];
  anchor: OverlayBucketRow | null;
}

/**
 * Pick one source per kind and shape the metrics. Pure: the read's rows in,
 * the DTO's metrics out.
 */
export function resolveNightOverlayMetrics(opts: {
  rows: readonly OverlayBucketRow[];
  grid: OverlayGrid;
  sessionSource: MeasurementSource | null;
  priorityJson: unknown;
}): NightOverlayMetric[] {
  const { grid } = opts;
  const byKey = new Map<string, Candidate>();
  for (const row of opts.rows) {
    const key = `${row.type}|${row.source}`;
    let cand = byKey.get(key);
    if (!cand) {
      cand = { type: row.type, source: row.source, buckets: [], anchor: null };
      byKey.set(key, cand);
    }
    if (row.idx === null) cand.anchor = row;
    else cand.buckets.push(row);
  }
  for (const cand of byKey.values())
    cand.buckets.sort((a, b) => a.idx! - b.idx!);

  const resolved = parseSourcePriority(opts.priorityJson);
  const ladderRank = (type: MeasurementType, source: MeasurementSource) => {
    const metricKey = metricKeyForType(type);
    const ladder = metricKey ? getSourceLadder(resolved, metricKey) : [];
    const i = ladder.indexOf(source);
    return i === -1 ? ladder.length : i;
  };
  const inSession = (b: OverlayBucketRow) =>
    b.idx! >= grid.firstSessionIdx && b.idx! <= grid.lastSessionIdx;

  const metrics: NightOverlayMetric[] = [];
  for (const kind of NIGHT_OVERLAY_KINDS) {
    const spec = OVERLAY_KIND_SPECS[kind];
    const cands = [...byKey.values()].filter((c) =>
      spec.types.includes(c.type),
    );
    const order = (a: Candidate, b: Candidate) =>
      Number(a.source !== opts.sessionSource) -
        Number(b.source !== opts.sessionSource) ||
      ladderRank(a.type, a.source) - ladderRank(b.type, b.source) ||
      spec.types.indexOf(a.type) - spec.types.indexOf(b.type) ||
      a.source.localeCompare(b.source);

    const series = cands
      .filter((c) => c.buckets.length >= 2 && c.buckets.some(inSession))
      .sort(order)[0];
    if (series) {
      const inside = series.buckets.filter(inSession);
      const n = inside.reduce((acc, b) => acc + b.n, 0);
      metrics.push({
        kind,
        type: series.type,
        unit: getUnitForType(series.type),
        source: series.source,
        points: series.buckets.map((b) => ({
          at: new Date(grid.originMs + b.idx! * grid.bucketMs).toISOString(),
          value: round1(b.sum / b.n),
          min: round1(b.min),
          max: round1(b.max),
        })),
        nightValue: null,
        summary: {
          min: round1(Math.min(...inside.map((b) => b.min))),
          max: round1(Math.max(...inside.map((b) => b.max))),
          avg: round1(inside.reduce((acc, b) => acc + b.sum, 0) / n),
        },
      });
      continue;
    }
    if (!spec.nightValue) continue;
    const single = cands
      .filter(
        (c) =>
          (c.buckets.length === 1 && inSession(c.buckets[0]!)) ||
          (c.buckets.length === 0 && c.anchor !== null),
      )
      .sort(order)[0];
    if (!single) continue;
    const row = single.buckets[0] ?? single.anchor!;
    metrics.push({
      kind,
      type: single.type,
      unit: getUnitForType(single.type),
      source: single.source,
      points: [],
      nightValue: round1(row.sum / row.n),
      summary: null,
    });
  }
  return metrics;
}

/**
 * The overlay types this account may read: a type owned by a module the
 * account switched off (RMSSD under recovery) is left out, as every other
 * read of it is. A type no module owns (`moduleForMeasurementType`: pulse,
 * SpO2, breathing, the temperatures) is always readable.
 */
export async function visibleOverlayTypes(
  userId: string,
): Promise<Set<MeasurementType>> {
  const all = NIGHT_OVERLAY_KINDS.flatMap((k) => OVERLAY_KIND_SPECS[k].types);
  const owners = [
    ...new Set(
      all.flatMap((type) => {
        const owner = moduleForMeasurementType(type);
        return owner ? [owner] : [];
      }),
    ),
  ];
  const enabled = new Map(
    await Promise.all(
      owners.map(
        async (owner) => [owner, await isModuleEnabled(userId, owner)] as const,
      ),
    ),
  );
  return new Set(
    all.filter((type) => {
      const owner = moduleForMeasurementType(type);
      return owner === null || enabled.get(owner) === true;
    }),
  );
}

/**
 * Read and resolve one night's overlays. The caller passes only a night with
 * a measured stage order; a night of stage totals has no timeline to lay a
 * line on.
 */
export async function readNightOverlays(opts: {
  userId: string;
  session: OverlaySession;
  priorityJson: unknown;
  visibleTypes: ReadonlySet<MeasurementType>;
}): Promise<NightOverlays> {
  const grid = overlayGrid(opts.session.start, opts.session.end);
  const base = {
    from: new Date(grid.originMs).toISOString(),
    to: new Date(grid.endMs).toISOString(),
    bucketMinutes: grid.bucketMs / 60_000,
  };
  const visible = (k: NightOverlayKind) =>
    OVERLAY_KIND_SPECS[k].types.filter((type) => opts.visibleTypes.has(type));
  const types = NIGHT_OVERLAY_KINDS.flatMap(visible);
  if (types.length === 0) return { ...base, metrics: [] };
  const anchorTypes = NIGHT_OVERLAY_KINDS.flatMap((k) =>
    OVERLAY_KIND_SPECS[k].nightValue ? visible(k) : [],
  );
  const rows = await prisma.$queryRaw<
    Array<{
      type: string;
      source: string;
      idx: number | null;
      n: number;
      sum: number;
      min_value: number;
      max_value: number;
    }>
  >(
    nightOverlaysSql({
      userId: opts.userId,
      types,
      anchorTypes,
      grid,
      anchor: canonicalDailyTimestamp(
        opts.session.night,
        opts.session.timeZone,
      ),
    }),
  );
  return {
    ...base,
    metrics: resolveNightOverlayMetrics({
      rows: rows.map((r) => ({
        type: r.type as MeasurementType,
        source: r.source as MeasurementSource,
        idx: r.idx === null ? null : Number(r.idx),
        n: Number(r.n),
        sum: Number(r.sum),
        min: Number(r.min_value),
        max: Number(r.max_value),
      })),
      grid,
      sessionSource: opts.session.source,
      priorityJson: opts.priorityJson,
    }),
  };
}
