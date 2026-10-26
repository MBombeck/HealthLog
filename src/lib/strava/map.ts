/**
 * Strava activities to workout rows: pure functions over the wire shapes
 * (`./wire-types.ts`), with no I/O. `__tests__/map-fixtures.test.ts` pins
 * what they make of sanitised fixtures.
 */
import type { Prisma } from "@/generated/prisma/client";
import { mapStravaSportType } from "./sport-map";
import type { WorkoutSportType } from "@/lib/validations/workout";
import type {
  StravaSummaryActivity,
  StravaDetailedActivity,
} from "./wire-types";

/** The `Workout`-row payload a mapped Strava activity produces. Field names
 * mirror `prisma.workout` columns; the sync layer stamps `source = STRAVA` +
 * `externalId` and upserts on `(userId, source, externalId)`. */
export interface StravaWorkoutRow {
  externalId: string;
  sportType: WorkoutSportType;
  startedAt: Date;
  endedAt: Date;
  durationSec: number;
  totalEnergyKcal: number | null;
  totalDistanceM: number | null;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
  elevationM: number | null;
  metadata: Prisma.InputJsonValue;
  /**
   * True when the row was mapped from the summary alone. The calories, the
   * description and (when the summary lacks it) the heart rate exist only on
   * the detail read, so an update from such a row must not write their
   * absence over what an earlier detail read stored.
   */
  summaryOnly?: boolean;
}

function nonNegInt(n: number | null | undefined): number | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

function nonNegFloat(n: number | null | undefined): number | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * Map one Strava activity into a `Workout` row. `sport_type` is preferred over
 * the legacy `type`, then mapped through `mapStravaSportType()` to a canonical
 * `WorkoutSportType` — the raw Strava label is never written to `sportType`
 * directly (see `src/lib/strava/sport-map.ts` for why). The raw label is kept
 * verbatim in `metadata.stravaType` for provenance/debugging. Duration uses
 * `moving_time` (active duration) with `elapsed_time` kept in `metadata`. HR /
 * calories come from the summary when present, else from the optional
 * `DetailedActivity`.
 *
 * The activity `name` / `description` are the user's own free-text DATA — they
 * are stored in `metadata` only and NEVER interpolated into any prompt as an
 * instruction (the MCP/coach free-text rule). Power / cadence / commute flags
 * ride `metadata` for provenance but are NOT surfaced as training analytics.
 * Returns null for an activity with no id / start instant (nothing to store).
 */
export function mapActivity(
  summary: StravaSummaryActivity,
  detail?: StravaDetailedActivity | null,
): StravaWorkoutRow | null {
  if (typeof summary.id !== "number") return null;
  const startIso = summary.start_date ?? detail?.start_date ?? null;
  if (!startIso) return null;
  const startedAt = new Date(startIso);
  if (Number.isNaN(startedAt.getTime())) return null;

  const elapsedSec = nonNegInt(summary.elapsed_time ?? detail?.elapsed_time);
  const movingSec = nonNegInt(summary.moving_time ?? detail?.moving_time);
  const durationSec = movingSec ?? elapsedSec ?? 0;
  // The clock window is elapsed time (moving time excludes pauses); fall back to
  // moving time when elapsed is absent so `endedAt` is never before `startedAt`.
  const endedAt = new Date(
    startedAt.getTime() + (elapsedSec ?? durationSec) * 1000,
  );

  const avgHeartRate = nonNegInt(
    summary.average_heartrate ?? detail?.average_heartrate,
  );
  const maxHeartRate = nonNegInt(
    summary.max_heartrate ?? detail?.max_heartrate,
  );
  const calories = nonNegFloat(detail?.calories);

  const rawSportType =
    summary.sport_type ?? summary.type ?? detail?.sport_type ?? "Workout";
  const sportType = mapStravaSportType(rawSportType);

  const metadata: Prisma.InputJsonValue = {
    // Activity name/description are user free-text → DATA, never instructions.
    ...(summary.name ? { stravaName: summary.name } : {}),
    ...(detail?.description ? { stravaDescription: detail.description } : {}),
    ...(elapsedSec != null ? { elapsedTimeSec: elapsedSec } : {}),
    // Raw pre-mapping label, kept for provenance/debugging — never used as
    // the canonical `sportType` itself (see `mapStravaSportType()`).
    ...(rawSportType ? { stravaType: rawSportType } : {}),
    ...(typeof summary.average_watts === "number"
      ? { averageWatts: summary.average_watts }
      : {}),
    ...(typeof summary.weighted_average_watts === "number"
      ? { weightedAverageWatts: summary.weighted_average_watts }
      : {}),
    ...(typeof summary.device_watts === "boolean"
      ? { deviceWatts: summary.device_watts }
      : {}),
    ...(typeof summary.average_cadence === "number"
      ? { averageCadence: summary.average_cadence }
      : {}),
    ...(typeof summary.trainer === "boolean"
      ? { trainer: summary.trainer }
      : {}),
    ...(typeof summary.commute === "boolean"
      ? { commute: summary.commute }
      : {}),
    ...(summary.gear_id ? { gearId: summary.gear_id } : {}),
  };

  return {
    externalId: String(summary.id),
    sportType,
    startedAt,
    endedAt,
    durationSec,
    totalEnergyKcal: calories,
    totalDistanceM: nonNegFloat(summary.distance ?? detail?.distance),
    avgHeartRate,
    maxHeartRate,
    elevationM: nonNegFloat(
      summary.total_elevation_gain ?? detail?.total_elevation_gain,
    ),
    metadata,
    summaryOnly: detail == null,
  };
}

/** True when the summary already carries HR + calories are irrelevant — i.e.
 * the summary alone is enough and a detail fetch can be skipped. Strava never
 * puts `calories` on the summary, so a detail fetch is what fills it; callers
 * use this only to decide whether HR is already covered. */
export function summaryHasHeartRate(a: StravaSummaryActivity): boolean {
  return (
    a.has_heartrate === true ||
    typeof a.average_heartrate === "number" ||
    typeof a.max_heartrate === "number"
  );
}
