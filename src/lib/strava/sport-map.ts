/**
 * Strava `sport_type` (and legacy `type`) → HealthLog canonical
 * `WorkoutSportType`.
 *
 * Strava was the second workout integration — after WHOOP — that shipped
 * WITHOUT this mapping. `mapActivity()` in `src/lib/strava/client.ts` used
 * to write `summary.sport_type ?? summary.type ?? detail?.sport_type ??
 * "workout"` straight into `Workout.sportType`, so a Strava "Run" or
 * "VirtualRide" never matched a canonical bucket — `/insights/workouts`
 * rendered every Strava row generic, and a picker that treats two generic
 * rows as the same sport clusters a same-source brick session (a Strava
 * "Ride" ending 15:00 immediately followed by a Strava "Run" starting
 * 15:03) into one and silently drops a leg. Google Health
 * (`mapGoogleHealthSportType()` in `src/lib/google-health/mappers.ts`) and
 * WHOOP (`mapWhoopSportType()` in `src/lib/whoop/sport-map.ts`) all
 * normalise at ingest time; this module brings Strava to parity.
 *
 * `STRAVA_SPORT_TABLE` is the single source of truth — `STRAVA_SPORT_MAP`
 * derives from it, and the one-shot data migration
 * `prisma/migrations/0251_backfill_strava_workout_sport` was generated FROM
 * this same table so the historical backfill and the live mapper never
 * drift apart.
 *
 * Source: Strava's public `SportType` model — the documented superset of
 * the deprecated `ActivityType` (`type`) enum, i.e. every legacy `type`
 * value already appears in this table under the same spelling. Captured
 * 2026-07-17 from the actively-maintained `stravalib` Python client's
 * generated model (`strava_model.py`), which mirrors Strava's published
 * Swagger spec 1:1 — 54 documented values.
 *
 * Bucket choices for sports with no clean 1:1 canonical match are a
 * judgment call, applied consistently with the WHOOP table:
 *   - paddle sports (Canoeing, Kayaking, StandUpPaddling) → `"rowing"`
 *     (closest upper-body cardio bucket, same call WHOOP made for
 *     Kayaking/Paddleboarding).
 *   - racket / paddle-court sports (Badminton, Padel, Pickleball,
 *     Racquetball, Squash, TableTennis, Tennis) → `"tennis"`.
 *   - functional / mixed-modal training (Crossfit, RockClimbing) →
 *     `"crossTraining"`.
 *   - recovery / mobility work (Pilates, PhysicalTherapy) → `"mindAndBody"`.
 *   - human-powered wheeled/pedaled locomotion with no dedicated bucket
 *     (EBikeRide, EMountainBikeRide, GravelRide, Handcycle,
 *     MountainBikeRide, Velomobile, VirtualRide) → `"cycling"`.
 *   - winter-hiking (Snowshoe) → `"hiking"`; snow-sliding sports with no
 *     bucket (AlpineSki, BackcountrySki, NordicSki, RollerSki, Snowboard)
 *     → `"other"`, same as WHOOP's Skiing/Snowboarding.
 *   - `VirtualRow` / `VirtualRun` → the same bucket as their non-virtual
 *     counterpart (`"rowing"` / `"running"`); `VirtualRide` → `"cycling"`.
 *   - team / niche sports with no matching bucket (Cricket, IceSkate,
 *     InlineSkate, Kitesurf, Sail, Skateboard, Surfing, Volleyball,
 *     Wheelchair, Windsurf) → `"other"`, same as an unmapped Fitbit or
 *     Google Health activity — the row still persists, just outside a
 *     canonical sport bucket.
 *   - the generic `"Workout"` label (Strava's own catch-all, and this
 *     module's pre-fix fallback) → `"other"`.
 */
import type { WorkoutSportType } from "@/lib/validations/workout";

interface StravaSportTableRow {
  /** Strava's documented `sport_type` value (PascalCase, no separators). */
  name: string;
  canonical: WorkoutSportType;
}

/**
 * Strava `sport_type` display name → canonical bucket. Alphabetical,
 * matching the `stravalib` model's declaration order. Keep this list —
 * and ONLY this list — in sync when Strava adds a sport; both
 * `STRAVA_SPORT_MAP` below and the 0251 migration's generator derive from
 * it.
 */
export const STRAVA_SPORT_TABLE: readonly StravaSportTableRow[] = [
  { name: "AlpineSki", canonical: "other" },
  { name: "BackcountrySki", canonical: "other" },
  { name: "Badminton", canonical: "tennis" },
  { name: "Basketball", canonical: "basketball" },
  { name: "Canoeing", canonical: "rowing" },
  { name: "Cricket", canonical: "other" },
  { name: "Crossfit", canonical: "crossTraining" },
  { name: "Dance", canonical: "dance" },
  { name: "EBikeRide", canonical: "cycling" },
  { name: "Elliptical", canonical: "elliptical" },
  { name: "EMountainBikeRide", canonical: "cycling" },
  { name: "Golf", canonical: "golf" },
  { name: "GravelRide", canonical: "cycling" },
  { name: "Handcycle", canonical: "cycling" },
  { name: "HighIntensityIntervalTraining", canonical: "hiit" },
  { name: "Hike", canonical: "hiking" },
  { name: "IceSkate", canonical: "other" },
  { name: "InlineSkate", canonical: "other" },
  { name: "Kayaking", canonical: "rowing" },
  { name: "Kitesurf", canonical: "other" },
  { name: "MountainBikeRide", canonical: "cycling" },
  { name: "NordicSki", canonical: "other" },
  { name: "Padel", canonical: "tennis" },
  { name: "PhysicalTherapy", canonical: "mindAndBody" },
  { name: "Pickleball", canonical: "tennis" },
  { name: "Pilates", canonical: "mindAndBody" },
  { name: "Racquetball", canonical: "tennis" },
  { name: "Ride", canonical: "cycling" },
  { name: "RockClimbing", canonical: "crossTraining" },
  { name: "RollerSki", canonical: "other" },
  { name: "Rowing", canonical: "rowing" },
  { name: "Run", canonical: "running" },
  { name: "Sail", canonical: "other" },
  { name: "Skateboard", canonical: "other" },
  { name: "Snowboard", canonical: "other" },
  { name: "Snowshoe", canonical: "hiking" },
  { name: "Soccer", canonical: "soccer" },
  { name: "Squash", canonical: "tennis" },
  { name: "StairStepper", canonical: "stairClimber" },
  { name: "StandUpPaddling", canonical: "rowing" },
  { name: "Surfing", canonical: "other" },
  { name: "Swim", canonical: "swimming" },
  { name: "TableTennis", canonical: "tennis" },
  { name: "Tennis", canonical: "tennis" },
  { name: "TrailRun", canonical: "running" },
  { name: "Velomobile", canonical: "cycling" },
  { name: "VirtualRide", canonical: "cycling" },
  { name: "VirtualRow", canonical: "rowing" },
  { name: "VirtualRun", canonical: "running" },
  { name: "Volleyball", canonical: "other" },
  { name: "Walk", canonical: "walking" },
  { name: "WeightTraining", canonical: "strength" },
  { name: "Wheelchair", canonical: "other" },
  { name: "Windsurf", canonical: "other" },
  { name: "Workout", canonical: "other" },
  { name: "Yoga", canonical: "yoga" },
] as const;

/**
 * Lowercase and strip every character outside `[a-z0-9]`. Strava's
 * `sport_type` values are PascalCase with no internal separators
 * ("VirtualRide"), so this is a plain case-fold in the common case; the
 * stripping step keeps the lookup resilient to a stray space/underscore/
 * hyphen variant ("Virtual Ride", "virtual_ride") resolving to the same
 * key. Applied to BOTH the documented display name (at table-build time)
 * and the incoming raw value (at lookup time).
 */
export function normaliseStravaSportKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export const STRAVA_SPORT_MAP: ReadonlyMap<string, WorkoutSportType> = new Map(
  STRAVA_SPORT_TABLE.map((row) => [
    normaliseStravaSportKey(row.name),
    row.canonical,
  ]),
);

/**
 * Resolve a Strava activity's sport to a canonical `WorkoutSportType`.
 * Accepts whichever raw label the caller has already resolved from the
 * `sport_type ?? type` fallback chain. Defaults to `"other"` for anything
 * absent, blank, or unrecognised (a Strava-added sport this table hasn't
 * caught up with yet); NEVER returns the raw Strava label.
 */
export function mapStravaSportType(
  raw: string | null | undefined,
): WorkoutSportType {
  if (typeof raw !== "string" || raw.trim() === "") return "other";
  return STRAVA_SPORT_MAP.get(normaliseStravaSportKey(raw)) ?? "other";
}
