/**
 * WHOOP `sport_id` / `sport_name` → HealthLog canonical `WorkoutSportType`.
 *
 * WHOOP is the only workout integration that shipped WITHOUT this mapping —
 * Google Health (`GOOGLE_HEALTH_EXERCISE_TYPE_MAP` in
 * `src/lib/google-health/mappers.ts`) normalises at ingest time. Before
 * this module, `sync-workout.ts` wrote WHOOP's raw `sport_name` or a literal
 * `whoop_sport_<id>` placeholder straight into `Workout.sportType`, so WHOOP
 * rows never matched a canonical bucket and the `/insights/workouts` list
 * couldn't icon/label them (a user's WHOOP-tracked rides rendered generic,
 * not "cycling").
 *
 * `WHOOP_SPORT_TABLE` is the single source of truth — both
 * `WHOOP_SPORT_ID_MAP` and `WHOOP_SPORT_NAME_MAP` derive from it, and the
 * one-shot data migration `prisma/migrations/0247_backfill_whoop_workout_sport`
 * was generated FROM this same table (see the migration file header) so the
 * historical backfill and the live mapper never drift apart.
 *
 * Source: WHOOP's public "Workout" object reference
 * (https://developer.whoop.com/docs/developing/user-data/workout/),
 * captured 2026-07-17. That page documents:
 *   - `sport_id` (int) — "ID of the WHOOP Sport performed during the
 *     workout. Will not exist past 09/01/2025." A ~120-row id → display-name
 *     table ships alongside it (Running, Cycling, Hiking/Rucking, ...).
 *   - `sport_name` (string) — "Name of the WHOOP Sport performed during the
 *     workout", the field that replaces `sport_id` going forward. The docs
 *     show exactly one example value (`"running"`, lowercase) and don't pin
 *     the exact separator convention WHOOP uses for multi-word sports (e.g.
 *     "Hiking/Rucking"), so `sport_name` lookups run through
 *     `normaliseSportKey()` — lowercase, non-alphanumeric runs collapsed to
 *     a single `_` — before the table lookup, making the match resilient to
 *     "Hiking/Rucking" / "hiking/rucking" / "hiking_rucking" all resolving
 *     to the same row.
 *
 * `mapWhoopSportType()` prefers `sport_id` when present — an exact integer
 * key needs no normalisation guess — and falls back to the normalised
 * `sport_name` (the only field WHOOP still sends post-2025-09-01). Anything
 * neither table recognises (a WHOOP-added sport, a malformed value) resolves
 * to `"other"`; the function NEVER returns a `whoop_sport_<n>` placeholder.
 *
 * Bucket choices for sports with no clean 1:1 canonical match are a judgment
 * call, applied consistently:
 *   - combat / interval-format classes (Boxing, Martial Arts, Jiu Jitsu,
 *     Kickboxing, Jumping Rope) → `"hiit"` (typical round-based structure).
 *   - functional / mixed-modal training (Functional Fitness, Gymnastics,
 *     Rock Climbing, Obstacle Course Racing, Parkour, F45, Barry's) →
 *     `"crossTraining"`.
 *   - paddle sports (Kayaking, Paddleboarding) → `"rowing"` (closest
 *     upper-body cardio bucket).
 *   - racket / paddle-court sports (Squash, Pickleball, Table Tennis,
 *     Badminton, Paddle Tennis, Padel) → `"tennis"`.
 *   - multi-discipline endurance events (Duathlon, Triathlon) →
 *     `"mixedCardio"`.
 *   - team / niche sports with no matching bucket (Baseball, Cricket, Ice
 *     Hockey, Sailing, Skiing, ...) → `"other"`, same as an unmapped Fitbit
 *     or Google Health activity — the row still persists, just outside a
 *     canonical sport bucket.
 */
import type { WorkoutSportType } from "@/lib/validations/workout";

interface WhoopSportTableRow {
  /** WHOOP's documented `sport_id`. Retired past 2025-09-01 but historical
   *  rows (and the 0247 backfill) still need it. */
  id: number;
  /** WHOOP's documented display name — normalised before lookup. */
  name: string;
  canonical: WorkoutSportType;
}

/**
 * WHOOP `sport_id` → display name → canonical bucket. Ordered by `id`
 * ascending, matching the developer-docs table. Keep this list — and ONLY
 * this list — in sync when WHOOP adds a sport; both maps below and the 0247
 * migration's generator script derive from it.
 */
export const WHOOP_SPORT_TABLE: readonly WhoopSportTableRow[] = [
  { id: -1, name: "Activity", canonical: "other" },
  { id: 0, name: "Running", canonical: "running" },
  { id: 1, name: "Cycling", canonical: "cycling" },
  { id: 16, name: "Baseball", canonical: "other" },
  { id: 17, name: "Basketball", canonical: "basketball" },
  { id: 18, name: "Rowing", canonical: "rowing" },
  { id: 19, name: "Fencing", canonical: "other" },
  { id: 20, name: "Field Hockey", canonical: "other" },
  { id: 21, name: "Football", canonical: "other" },
  { id: 22, name: "Golf", canonical: "golf" },
  { id: 24, name: "Ice Hockey", canonical: "other" },
  { id: 25, name: "Lacrosse", canonical: "other" },
  { id: 27, name: "Rugby", canonical: "other" },
  { id: 28, name: "Sailing", canonical: "other" },
  { id: 29, name: "Skiing", canonical: "other" },
  { id: 30, name: "Soccer", canonical: "soccer" },
  { id: 31, name: "Softball", canonical: "other" },
  { id: 32, name: "Squash", canonical: "tennis" },
  { id: 33, name: "Swimming", canonical: "swimming" },
  { id: 34, name: "Tennis", canonical: "tennis" },
  { id: 35, name: "Track & Field", canonical: "running" },
  { id: 36, name: "Volleyball", canonical: "other" },
  { id: 37, name: "Water Polo", canonical: "swimming" },
  { id: 38, name: "Wrestling", canonical: "strength" },
  { id: 39, name: "Boxing", canonical: "hiit" },
  { id: 42, name: "Dance", canonical: "dance" },
  { id: 43, name: "Pilates", canonical: "mindAndBody" },
  { id: 44, name: "Yoga", canonical: "yoga" },
  { id: 45, name: "Weightlifting", canonical: "strength" },
  { id: 47, name: "Cross Country Skiing", canonical: "other" },
  { id: 48, name: "Functional Fitness", canonical: "crossTraining" },
  { id: 49, name: "Duathlon", canonical: "mixedCardio" },
  { id: 51, name: "Gymnastics", canonical: "crossTraining" },
  { id: 52, name: "Hiking/Rucking", canonical: "hiking" },
  { id: 53, name: "Horseback Riding", canonical: "other" },
  { id: 55, name: "Kayaking", canonical: "rowing" },
  { id: 56, name: "Martial Arts", canonical: "hiit" },
  { id: 57, name: "Mountain Biking", canonical: "cycling" },
  { id: 59, name: "Powerlifting", canonical: "strength" },
  { id: 60, name: "Rock Climbing", canonical: "crossTraining" },
  { id: 61, name: "Paddleboarding", canonical: "rowing" },
  { id: 62, name: "Triathlon", canonical: "mixedCardio" },
  { id: 63, name: "Walking", canonical: "walking" },
  { id: 64, name: "Surfing", canonical: "other" },
  { id: 65, name: "Elliptical", canonical: "elliptical" },
  { id: 66, name: "Stairmaster", canonical: "stairClimber" },
  { id: 70, name: "Meditation", canonical: "mindAndBody" },
  { id: 71, name: "Other", canonical: "other" },
  { id: 73, name: "Diving", canonical: "other" },
  { id: 74, name: "Operations - Tactical", canonical: "other" },
  { id: 75, name: "Operations - Medical", canonical: "other" },
  { id: 76, name: "Operations - Flying", canonical: "other" },
  { id: 77, name: "Operations - Water", canonical: "other" },
  { id: 82, name: "Ultimate", canonical: "other" },
  { id: 83, name: "Climber", canonical: "stairClimber" },
  { id: 84, name: "Jumping Rope", canonical: "hiit" },
  { id: 85, name: "Australian Football", canonical: "other" },
  { id: 86, name: "Skateboarding", canonical: "other" },
  { id: 87, name: "Coaching", canonical: "other" },
  { id: 88, name: "Ice Bath", canonical: "other" },
  { id: 89, name: "Commuting", canonical: "other" },
  { id: 90, name: "Gaming", canonical: "other" },
  { id: 91, name: "Snowboarding", canonical: "other" },
  { id: 92, name: "Motocross", canonical: "other" },
  { id: 93, name: "Caddying", canonical: "other" },
  { id: 94, name: "Obstacle Course Racing", canonical: "crossTraining" },
  { id: 95, name: "Motor Racing", canonical: "other" },
  { id: 96, name: "HIIT", canonical: "hiit" },
  { id: 97, name: "Spin", canonical: "cycling" },
  { id: 98, name: "Jiu Jitsu", canonical: "hiit" },
  { id: 99, name: "Manual Labor", canonical: "other" },
  { id: 100, name: "Cricket", canonical: "other" },
  { id: 101, name: "Pickleball", canonical: "tennis" },
  { id: 102, name: "Inline Skating", canonical: "other" },
  { id: 103, name: "Box Fitness", canonical: "hiit" },
  { id: 104, name: "Spikeball", canonical: "other" },
  { id: 105, name: "Wheelchair Pushing", canonical: "other" },
  { id: 106, name: "Paddle Tennis", canonical: "tennis" },
  { id: 107, name: "Barre", canonical: "mindAndBody" },
  { id: 108, name: "Stage Performance", canonical: "other" },
  { id: 109, name: "High Stress Work", canonical: "other" },
  { id: 110, name: "Parkour", canonical: "crossTraining" },
  { id: 111, name: "Gaelic Football", canonical: "other" },
  { id: 112, name: "Hurling/Camogie", canonical: "other" },
  { id: 113, name: "Circus Arts", canonical: "other" },
  { id: 121, name: "Massage Therapy", canonical: "other" },
  { id: 123, name: "Strength Trainer", canonical: "strength" },
  { id: 125, name: "Watching Sports", canonical: "other" },
  { id: 126, name: "Assault Bike", canonical: "cycling" },
  { id: 127, name: "Kickboxing", canonical: "hiit" },
  { id: 128, name: "Stretching", canonical: "mindAndBody" },
  { id: 230, name: "Table Tennis", canonical: "tennis" },
  { id: 231, name: "Badminton", canonical: "tennis" },
  { id: 232, name: "Netball", canonical: "basketball" },
  { id: 233, name: "Sauna", canonical: "other" },
  { id: 234, name: "Disc Golf", canonical: "golf" },
  { id: 235, name: "Yard Work", canonical: "other" },
  { id: 236, name: "Air Compression", canonical: "other" },
  { id: 237, name: "Percussive Massage", canonical: "other" },
  { id: 238, name: "Paintball", canonical: "other" },
  { id: 239, name: "Ice Skating", canonical: "other" },
  { id: 240, name: "Handball", canonical: "other" },
  { id: 248, name: "F45 Training", canonical: "crossTraining" },
  { id: 249, name: "Padel", canonical: "tennis" },
  { id: 250, name: "Barry's", canonical: "crossTraining" },
  { id: 251, name: "Dedicated Parenting", canonical: "other" },
  { id: 252, name: "Stroller Walking", canonical: "walking" },
  { id: 253, name: "Stroller Jogging", canonical: "running" },
  { id: 254, name: "Toddlerwearing", canonical: "other" },
  { id: 255, name: "Babywearing", canonical: "other" },
  { id: 258, name: "Barre3", canonical: "mindAndBody" },
  { id: 259, name: "Hot Yoga", canonical: "yoga" },
  { id: 261, name: "Stadium Steps", canonical: "stairClimber" },
  { id: 262, name: "Polo", canonical: "other" },
  { id: 263, name: "Musical Performance", canonical: "other" },
  { id: 264, name: "Kite Boarding", canonical: "other" },
  { id: 266, name: "Dog Walking", canonical: "walking" },
  { id: 267, name: "Water Skiing", canonical: "other" },
  { id: 268, name: "Wakeboarding", canonical: "other" },
  { id: 269, name: "Cooking", canonical: "other" },
  { id: 270, name: "Cleaning", canonical: "other" },
  { id: 272, name: "Public Speaking", canonical: "other" },
] as const;

/**
 * Lowercase, collapse any run of characters that aren't `[a-z0-9_]` into a
 * single `_`, then trim leading/trailing `_`. Applied to BOTH the
 * documented display name (at table-build time) and the incoming
 * `sport_name` (at lookup time) so "Hiking/Rucking", "hiking/rucking", and
 * "hiking_rucking" all resolve to the same key. Existing underscores pass
 * through untouched — load-bearing for the `whoop_sport_<id>` legacy
 * placeholder values the 0247 backfill also has to recognise.
 */
export function normaliseSportKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export const WHOOP_SPORT_ID_MAP: ReadonlyMap<number, WorkoutSportType> =
  new Map(WHOOP_SPORT_TABLE.map((row) => [row.id, row.canonical]));

export const WHOOP_SPORT_NAME_MAP: ReadonlyMap<string, WorkoutSportType> =
  new Map(
    WHOOP_SPORT_TABLE.map((row) => [
      normaliseSportKey(row.name),
      row.canonical,
    ]),
  );

/**
 * Resolve a WHOOP workout's sport to a canonical `WorkoutSportType`. Prefers
 * `sport_id` (exact integer key, no normalisation guesswork) when present,
 * then falls back to the normalised `sport_name` — the only field WHOOP
 * still sends since `sport_id` was retired 2025-09-01. Defaults to
 * `"other"`; never returns a `whoop_sport_<n>` placeholder.
 */
export function mapWhoopSportType(
  sportId?: number,
  sportName?: string,
): WorkoutSportType {
  if (typeof sportId === "number") {
    const byId = WHOOP_SPORT_ID_MAP.get(sportId);
    if (byId) return byId;
  }
  if (typeof sportName === "string" && sportName.trim() !== "") {
    const byName = WHOOP_SPORT_NAME_MAP.get(normaliseSportKey(sportName));
    if (byName) return byName;
  }
  return "other";
}
