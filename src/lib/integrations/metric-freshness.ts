/**
 * Per-metric-type freshness (the smallest honest signal).
 *
 * Freshness was tracked only per-integration (`IntegrationStatus.lastSuccessAt`
 * / a connection's `lastSyncedAt`). A provider that returns HTTP 200 with an
 * empty body for ONE data type produces zero rows, throws nothing, and the
 * other types in the same cycle stamp the whole integration green — so the
 * Settings pill reads "connected · 5 min ago" while, say, respiratory rate has
 * been dead since launch, and nothing distinguishes "broken pipe" from "healthy
 * but idle".
 *
 * This computes the last-value timestamp per `(source, type)` straight from the
 * `Measurement` table so a caller can surface
 * per-metric liveness honestly: a metric whose newest reading is frozen weeks in
 * the past is visibly distinct from one that is genuinely current. The
 * classification of "quiet" vs "current" is a pure function next to the verdict
 * (`classifyMetricFreshness` in `./sync-verdict`); this module only reads.
 *
 * Two sources write no `Measurement` rows for part of what they deliver:
 * Strava writes only `Workout` rows, and Polar's workout leg is one of its two
 * cron legs. A second grouped read over `Workout` appends a `WORKOUTS`
 * pseudo-entry so those pipes are visible too, and a third over `CycleDayLog`
 * a `CYCLE_DAYS` entry for the wearables that import period days.
 */
import { prisma } from "@/lib/db";
import type {
  MeasurementSource,
  MeasurementType,
} from "@/generated/prisma/client";
import { listLiveMeasurementTypes } from "@/lib/measurements/live-types";
import type { IntegrationKey } from "./status";
import {
  CYCLE_DAY_FRESHNESS_TYPE,
  MEDICATION_DOSE_FRESHNESS_TYPE,
  WORKOUT_FRESHNESS_TYPE,
  type MetricFreshnessSample,
} from "./sync-verdict";

export type {
  MetricFreshnessEntry,
  MetricFreshnessSample,
} from "./sync-verdict";

/**
 * The `MeasurementSource` each sync integration's rows carry. `strava` is
 * absent — it writes `Workout` rows, not `Measurement` rows — and picks up its
 * `WORKOUTS` entry below.
 */
export const INTEGRATION_MEASUREMENT_SOURCE: Partial<
  Record<IntegrationKey, MeasurementSource>
> = {
  withings: "WITHINGS",
  whoop: "WHOOP",
  fitbit: "FITBIT",
  nightscout: "NIGHTSCOUT",
  polar: "POLAR",
  oura: "OURA",
  "google-health": "GOOGLE_HEALTH",
  garmin: "GARMIN",
};

/**
 * The `MeasurementSource` each workout-writing integration's `Workout` rows
 * carry. Strava is workouts-only; Polar syncs workouts alongside its
 * measurements.
 */
export const INTEGRATION_WORKOUT_SOURCE: Partial<
  Record<IntegrationKey, MeasurementSource>
> = {
  strava: "STRAVA",
  polar: "POLAR",
  // These three write workouts too, and were missing from this table, so their
  // cards could report every measurement type fresh while the workout leg had
  // been silent for weeks — the freshness disclosure had no row to go quiet.
  whoop: "WHOOP",
  fitbit: "FITBIT",
  "google-health": "GOOGLE_HEALTH",
  garmin: "GARMIN",
};

/** The `CycleDayLog` source of each integration that imports period days. */
export const INTEGRATION_CYCLE_SOURCE: Partial<
  Record<IntegrationKey, MeasurementSource>
> = {
  garmin: "GARMIN",
  oura: "OURA",
};

/**
 * Newest measurement per `(source, type)` for the given sources. A `(source,
 * type)` pair with no rows simply has no entry, which is how honest absence
 * stays structural — a metric a provider never delivered is never invented.
 *
 * v1.42: this used to be one `groupBy … _max(measuredAt)` over every live row
 * of the sources, which on a multi-year Apple Health history reads six figures
 * of rows for a two-digit answer on every settings visit. It now asks which
 * types are live per source (`listLiveMeasurementTypes`, a loose index scan)
 * and then probes each type's newest row through the same partial covering
 * index, one `LIMIT 1` per type.
 */
export async function getMeasurementFreshnessBySource(
  userId: string,
  sources: readonly MeasurementSource[],
): Promise<Map<MeasurementSource, MetricFreshnessSample[]>> {
  const out = new Map<MeasurementSource, MetricFreshnessSample[]>();
  const perSource = await Promise.all(
    [...new Set(sources)].map(async (source) => {
      const types = await listLiveMeasurementTypes(userId, { source });
      return { source, samples: await newestPerType(userId, source, types) };
    }),
  );
  for (const { source, samples } of perSource) {
    if (samples.length > 0) out.set(source, samples);
  }
  return out;
}

async function newestPerType(
  userId: string,
  source: MeasurementSource,
  types: readonly MeasurementType[],
): Promise<MetricFreshnessSample[]> {
  if (types.length === 0) return [];
  // Parameter-bound throughout; the enum casts are literal SQL.
  const rows = await prisma.$queryRaw<
    Array<{ type: string; last_seen: Date | null }>
  >`
    SELECT live."type"::text AS "type",
      (
        SELECT m."measured_at"
        FROM "measurements" m
        WHERE m."user_id" = ${userId}
          AND m."type" = live."type"
          AND m."deleted_at" IS NULL
          AND m."source" = ${source}::"measurement_source"
        ORDER BY m."measured_at" DESC
        LIMIT 1
      ) AS "last_seen"
    FROM unnest(${[...types]}::"measurement_type"[]) AS live("type")
  `;
  const samples: MetricFreshnessSample[] = [];
  for (const row of rows) {
    if (!row.last_seen) continue;
    samples.push({
      type: row.type,
      lastSeenAt: new Date(row.last_seen).toISOString(),
    });
  }
  return samples;
}

/**
 * Newest workout per source. `Workout` rows are hard-deleted, so there is no
 * tombstone predicate to apply.
 */
export async function getWorkoutFreshnessBySource(
  userId: string,
  sources: readonly MeasurementSource[],
): Promise<Map<MeasurementSource, string>> {
  const out = new Map<MeasurementSource, string>();
  if (sources.length === 0) return out;

  const grouped = await prisma.workout.groupBy({
    by: ["source"],
    where: { userId, source: { in: [...sources] } },
    _max: { startedAt: true },
  });

  for (const row of grouped) {
    const lastSeen = row._max.startedAt;
    if (!lastSeen) continue;
    out.set(row.source, lastSeen.toISOString());
  }
  return out;
}

/**
 * Newest live cycle day per source, with the count, as a `CYCLE_DAYS` sample.
 * A cycle day is a calendar day, dated at noon UTC like every date-only value.
 */
export async function getCycleDayFreshnessBySource(
  userId: string,
  sources: readonly MeasurementSource[],
): Promise<Map<MeasurementSource, MetricFreshnessSample>> {
  const out = new Map<MeasurementSource, MetricFreshnessSample>();
  if (sources.length === 0) return out;
  const grouped = await prisma.cycleDayLog.groupBy({
    by: ["source"],
    where: { userId, deletedAt: null, source: { in: [...sources] } },
    _max: { date: true },
    _count: { _all: true },
  });
  for (const row of grouped) {
    if (!row._max.date) continue;
    out.set(row.source, {
      type: CYCLE_DAY_FRESHNESS_TYPE,
      lastSeenAt: `${row._max.date}T12:00:00.000Z`,
      count: row._count._all,
    });
  }
  return out;
}

/**
 * Per-metric last-value timestamps for one measurement source, sorted
 * alphabetically for a stable wire shape. Used by the Apple Health route, whose
 * transport sits outside the integration envelope.
 */
export async function getSourceFreshness(
  userId: string,
  source: MeasurementSource,
): Promise<MetricFreshnessSample[]> {
  const [measurements, workouts] = await Promise.all([
    getMeasurementFreshnessBySource(userId, [source]),
    getWorkoutFreshnessBySource(userId, [source]),
  ]);
  const entries = measurements.get(source) ?? [];
  const workoutSeenAt = workouts.get(source);
  if (workoutSeenAt) {
    entries.push({
      type: WORKOUT_FRESHNESS_TYPE,
      lastSeenAt: workoutSeenAt,
    });
  }
  return sortByType(entries);
}

/**
 * The newest Apple Health medication dose, as the `MEDICATION_DOSE` sample of
 * the Apple Health freshness list (v1.42.4). A dose row carries an
 * `externalId` only when it came from Apple Health (the intake bulk route
 * accepts one solely with `source: "APPLE_HEALTH"`, and a slot write that
 * converges onto an existing row keeps the id), so that column, not
 * `source`, is what identifies them. A taken dose is dated by when it was
 * taken, a skipped one by its slot. Null when there is no live Apple Health
 * dose, so the entry is absent rather than invented.
 */
export async function getAppleHealthDoseFreshness(
  userId: string,
): Promise<MetricFreshnessSample | null> {
  const rows = await prisma.$queryRaw<Array<{ last_seen: Date | null }>>`
    SELECT max(COALESCE(e."taken_at", e."scheduled_for")) AS "last_seen"
    FROM "medication_intake_events" e
    WHERE e."user_id" = ${userId}
      AND e."external_id" IS NOT NULL
      AND e."deleted_at" IS NULL
  `;
  const lastSeen = rows[0]?.last_seen;
  if (!lastSeen) return null;
  return {
    type: MEDICATION_DOSE_FRESHNESS_TYPE,
    lastSeenAt: new Date(lastSeen).toISOString(),
  };
}

/**
 * The newest reading entered here, not arrived from Apple Health, for each of
 * `types` (#1247): the readings the app writes back to the phone. Every
 * requested type has a key, null when there is none, so a write-back type is
 * recognisable on the wire even before its first entry.
 */
export async function getEnteredHereAt(
  userId: string,
  types: readonly MeasurementType[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>(types.map((t) => [t, null]));
  if (types.length === 0) return out;
  // One `LIMIT 1` per type down the (user, type, measured_at) index; the
  // enum casts are literal SQL, everything else is bound.
  const rows = await prisma.$queryRaw<
    Array<{ type: string; last_seen: Date | null }>
  >`
    SELECT wanted."type"::text AS "type",
      (
        SELECT m."measured_at"
        FROM "measurements" m
        WHERE m."user_id" = ${userId}
          AND m."type" = wanted."type"
          AND m."deleted_at" IS NULL
          AND m."source" <> 'APPLE_HEALTH'::"measurement_source"
        ORDER BY m."measured_at" DESC
        LIMIT 1
      ) AS "last_seen"
    FROM unnest(${[...types]}::"measurement_type"[]) AS wanted("type")
  `;
  for (const row of rows) {
    if (row.last_seen && out.has(row.type)) {
      out.set(row.type, new Date(row.last_seen).toISOString());
    }
  }
  return out;
}

/**
 * Compute per-`(integration, type)` last-value timestamps for the sync
 * integrations, keyed by `IntegrationKey`. Three grouped reads (measurements,
 * workouts, cycle days); a source with no rows simply has no entry.
 */
export async function getSourceMetricFreshness(
  userId: string,
): Promise<Partial<Record<IntegrationKey, MetricFreshnessSample[]>>> {
  const [measurements, workouts, cycleDays] = await Promise.all([
    getMeasurementFreshnessBySource(
      userId,
      Object.values(INTEGRATION_MEASUREMENT_SOURCE),
    ),
    getWorkoutFreshnessBySource(
      userId,
      Object.values(INTEGRATION_WORKOUT_SOURCE),
    ),
    getCycleDayFreshnessBySource(
      userId,
      Object.values(INTEGRATION_CYCLE_SOURCE),
    ),
  ]);

  const out: Partial<Record<IntegrationKey, MetricFreshnessSample[]>> = {};

  for (const [key, source] of Object.entries(
    INTEGRATION_MEASUREMENT_SOURCE,
  ) as Array<[IntegrationKey, MeasurementSource]>) {
    const entries = measurements.get(source);
    if (entries?.length) out[key] = entries;
  }

  for (const [key, source] of Object.entries(
    INTEGRATION_WORKOUT_SOURCE,
  ) as Array<[IntegrationKey, MeasurementSource]>) {
    const lastSeenAt = workouts.get(source);
    if (!lastSeenAt) continue;
    (out[key] ??= []).push({
      type: WORKOUT_FRESHNESS_TYPE,
      lastSeenAt,
    });
  }

  for (const [key, source] of Object.entries(INTEGRATION_CYCLE_SOURCE) as Array<
    [IntegrationKey, MeasurementSource]
  >) {
    const sample = cycleDays.get(source);
    if (sample) (out[key] ??= []).push(sample);
  }

  for (const key of Object.keys(out) as IntegrationKey[]) {
    out[key] = sortByType(out[key]!);
  }
  return out;
}

function sortByType(entries: MetricFreshnessSample[]): MetricFreshnessSample[] {
  return [...entries].sort((a, b) => a.type.localeCompare(b.type));
}
