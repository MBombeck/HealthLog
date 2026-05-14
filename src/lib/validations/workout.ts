import { z } from "zod/v4";
import { measurementSourceEnum } from "./measurement";

/**
 * Workout sport-type union.
 *
 * Stored as a TEXT column at the DB layer (see `Workout.sport_type` in
 * `prisma/schema.prisma`) rather than a Postgres enum. Apple alone has
 * 70+ `HKWorkoutActivityType` values and the long tail (paddle / row /
 * ski / etc.) only grows release-on-release. A Zod `enum` here gives
 * compile-time exhaustiveness without making every new sport a Postgres
 * migration. Adding a new sport: append the literal to this union and
 * any source-specific code that maps to it (e.g. an HK numeric-code →
 * union entry in `apple-health-mapping.ts`).
 *
 * The initial roster covers ≥98% of typical workouts observed across
 * the open-source Apple Health corpora referenced in the W8d research
 * outline. Anything not in the list lands as `"other"` until promoted
 * to a first-class member.
 */
export const workoutSportTypeEnum = z.enum([
  "walking",
  "running",
  "cycling",
  "hiking",
  "swimming",
  "rowing",
  "elliptical",
  "stairClimber",
  "yoga",
  "mindAndBody",
  "strength",
  "hiit",
  "dance",
  "golf",
  "tennis",
  "basketball",
  "soccer",
  "crossTraining",
  "mixedCardio",
  "other",
]);

export type WorkoutSportType = z.infer<typeof workoutSportTypeEnum>;

/**
 * Upper bound on points per route LineString. A 24h ultra at 1Hz lands
 * at 86 400 points; 20 000 covers any normal run / ride / hike while
 * still rejecting pathological payloads (an attacker shipping a 5 MB
 * route per workout * 100 workouts/batch * unbounded retries). The
 * route geometry is the largest tail in the batch payload — keeping it
 * bounded keeps the total request body bounded with it.
 */
export const MAX_ROUTE_POINTS = 20_000;

/**
 * GeoJSON LineString — the WorkoutRoute.geometry shape. RFC 7946 §3.1.4
 * with one HealthLog-specific allowance: the altitude component on
 * each coordinate is optional. Apple HKWorkoutRoute carries it; some
 * GPX imports do not.
 */
export const geoJsonLineStringSchema = z.object({
  type: z.literal("LineString"),
  coordinates: z
    .array(
      z
        .tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])
        .rest(z.number()),
    )
    .min(2, "LineString requires at least 2 points")
    .max(
      MAX_ROUTE_POINTS,
      `LineString exceeds the ${MAX_ROUTE_POINTS}-point cap`,
    ),
});

export type GeoJsonLineString = z.infer<typeof geoJsonLineStringSchema>;

/**
 * Per-sample timestamp + speed companion to the LineString. Parallel
 * to `coordinates` — same length, one entry per point. NULL at the
 * column level when the source only ships static GPX (Withings).
 */
export const workoutRouteSamplesSchema = z.array(
  z.object({
    t: z.iso.datetime({ offset: true }),
    speedMs: z.number().min(0).max(50).optional(),
    hr: z.number().int().min(20).max(300).optional(),
  }),
);

export type WorkoutRouteSamples = z.infer<typeof workoutRouteSamplesSchema>;

/**
 * Workout insert payload — the shape `POST /api/workouts/batch` accepts.
 * Defined here so the iOS Swift session can generate its DTO against the
 * locked contract and the v1.4.26 XML import worker has the same target.
 *
 * Cross-field invariants enforced via `.superRefine()`:
 *   - `endedAt` MUST be strictly greater than `startedAt`. A workout
 *     with `endedAt <= startedAt` produces a non-positive
 *     `durationSec`, which downstream consumers (PR detector, weekly
 *     report, dashboards) treat as a "real" zero — locking in a
 *     fastest-5km time of zero seconds is far worse than refusing the
 *     ingest at the schema gate.
 *   - When `route.sampleTimestamps` is present, its length MUST equal
 *     `route.geometry.coordinates.length`. A desynced pair silently
 *     degrades downstream analytics (per-sample HR / speed would line
 *     up against the wrong coordinate), so we hard-fail at parse time.
 */
export const createWorkoutSchema = z
  .object({
    sportType: workoutSportTypeEnum,
    startedAt: z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
    endedAt: z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
    totalEnergyKcal: z.number().min(0).max(50000).optional(),
    totalDistanceM: z.number().min(0).max(1_000_000).optional(),
    avgHeartRate: z.number().int().min(20).max(300).optional(),
    maxHeartRate: z.number().int().min(20).max(300).optional(),
    minHeartRate: z.number().int().min(20).max(300).optional(),
    stepCount: z.number().int().min(0).max(200_000).optional(),
    elevationM: z.number().min(-500).max(10_000).optional(),
    pauseDurationSec: z.number().int().min(0).max(86_400).optional(),
    source: measurementSourceEnum.optional().default("MANUAL"),
    externalId: z.string().max(128).optional(),
    externalSourceVersion: z.string().max(64).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    route: z
      .object({
        geometry: geoJsonLineStringSchema,
        sampleTimestamps: workoutRouteSamplesSchema.optional(),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.endedAt.getTime() <= value.startedAt.getTime()) {
      ctx.addIssue({
        code: "custom",
        path: ["endedAt"],
        message: "endedAt must be strictly after startedAt",
      });
    }
    const samples = value.route?.sampleTimestamps;
    const coords = value.route?.geometry.coordinates;
    if (samples && coords && samples.length !== coords.length) {
      ctx.addIssue({
        code: "custom",
        path: ["route", "sampleTimestamps"],
        message:
          "sampleTimestamps length must match geometry.coordinates length",
      });
    }
  });

export type CreateWorkoutInput = z.infer<typeof createWorkoutSchema>;

/**
 * Upper bound on workouts per batch ingest call. Workouts are heavier
 * than measurements (each may carry a 20 000-point route geometry), so
 * the cap is an order of magnitude tighter than the 500-entry
 * measurements batch. A cold-start iOS HealthKit backfill is "every
 * workout I've ever recorded" — 100 covers a healthy multi-year history
 * and rejects pathological cases without forcing pagination on the
 * happy path.
 */
export const MAX_WORKOUTS_PER_BATCH = 100;

/**
 * Batch ingest payload — `{ workouts: [createWorkoutSchema, ...] }`.
 * Mirrors `createBatchMeasurementSchema` shape so the iOS sync engine
 * can re-use the same retry / cursor plumbing. Each entry is a typed
 * workout; an optional nested `route` carries the GeoJSON LineString.
 */
export const createBatchWorkoutSchema = z.object({
  workouts: z
    .array(createWorkoutSchema)
    .min(1)
    .max(MAX_WORKOUTS_PER_BATCH),
});

export type CreateBatchWorkoutInput = z.infer<typeof createBatchWorkoutSchema>;
