import { z } from "zod/v4";
import { writableMeasurementSourceEnum } from "./measurement";
import { isoDateTime } from "@/lib/validations/datetime";

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
  "badminton",
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
    t: isoDateTime(),
    speedMs: z.number().min(0).max(50).optional(),
    hr: z.number().int().min(20).max(300).optional(),
  }),
);

export type WorkoutRouteSamples = z.infer<typeof workoutRouteSamplesSchema>;

/**
 * Upper bound on per-workout heart-rate samples. HealthKit emits a HR
 * sample roughly every 5 s during a workout — a 6-hour ultra at that
 * cadence lands at ~4 320 points, and even a 1 Hz reconstruction of
 * that session is ~21 600. 30 000 covers any realistic single session
 * (including long endurance events sampled at 1 Hz) while still
 * rejecting pathological payloads. The series is the largest new
 * workout-side write stream, so the cap keeps each workout's payload —
 * and the total request body — bounded the same way `MAX_ROUTE_POINTS`
 * bounds the route geometry. iOS should downsample to ≤ this many
 * points (e.g. 1-min buckets for very long sessions) before posting.
 */
export const MAX_WORKOUT_HR_SAMPLES = 30_000;

/**
 * Route-INDEPENDENT per-workout heart-rate series — the
 * `WorkoutSamples.samples` shape. Mirrors `workoutRouteSamplesSchema`
 * but carries no geometry coupling, so an indoor workout (no GPS) can
 * still ship its HR signal for the training-strain engine.
 *
 * `t` is the per-sample ISO timestamp; `hr` beats/min. `speedMs` /
 * `power` / `cadence` are optional companion channels HealthKit may
 * report (cycling power meters, running cadence). Every channel is
 * optional EXCEPT `t` so a sparse series (HR only) is valid; an entry
 * with no signal channel at all is still permitted (a bare timestamp)
 * but carries no analytical value.
 */
export const workoutHrSamplesSchema = z
  .array(
    z.object({
      t: isoDateTime(),
      hr: z.number().int().min(20).max(300).optional(),
      speedMs: z.number().min(0).max(50).optional(),
      power: z.number().min(0).max(3000).optional(),
      cadence: z.number().min(0).max(400).optional(),
    }),
  )
  .min(1, "samples requires at least 1 point")
  .max(
    MAX_WORKOUT_HR_SAMPLES,
    `samples exceeds the ${MAX_WORKOUT_HR_SAMPLES}-point cap`,
  );

export type WorkoutHrSamples = z.infer<typeof workoutHrSamplesSchema>;

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
    startedAt: isoDateTime().transform((s) => new Date(s)),
    endedAt: isoDateTime().transform((s) => new Date(s)),
    totalEnergyKcal: z.number().min(0).max(50000).optional(),
    totalDistanceM: z.number().min(0).max(1_000_000).optional(),
    avgHeartRate: z.number().int().min(20).max(300).optional(),
    maxHeartRate: z.number().int().min(20).max(300).optional(),
    minHeartRate: z.number().int().min(20).max(300).optional(),
    stepCount: z.number().int().min(0).max(200_000).optional(),
    elevationM: z.number().min(-500).max(10_000).optional(),
    pauseDurationSec: z.number().int().min(0).max(86_400).optional(),
    // Narrowed to the client-writable subset ({MANUAL, APPLE_HEALTH}) — the
    // same allowlist the measurement writes use (`WRITABLE_MEASUREMENT_SOURCES`
    // / `batchSourceEnum`). Server-owned sources (WHOOP, FITBIT) write directly
    // via `prisma.workout.upsert` with a hardcoded `source`, never through this
    // schema, so a client cannot forge a row attributed to an integration it
    // does not own.
    source: writableMeasurementSourceEnum.optional().default("MANUAL"),
    // The only writer of this schema is the batch ingest, which enforces
    // external-id stability per entry rather than at the field: a
    // schema-level refusal would fail the whole batch on one bad row.
    // @external-id-checked-per-entry: src/lib/workouts/batch-ingest/entries.ts
    externalId: z.string().max(128).optional(),
    externalSourceVersion: z.string().max(64).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    route: z
      .object({
        geometry: geoJsonLineStringSchema,
        sampleTimestamps: workoutRouteSamplesSchema.optional(),
      })
      .optional(),
    /**
     * Route-independent per-workout heart-rate series. Persisted to the
     * `WorkoutSamples` child so an indoor workout (no GPS route) still
     * yields a strain-relevant HR signal. Independent of `route` — a
     * GPS workout MAY carry both (`route.sampleTimestamps` for the
     * geometry-aligned series, `samples` for the canonical HR series);
     * an indoor workout carries only `samples`.
     */
    samples: workoutHrSamplesSchema.optional(),
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
  workouts: z.array(createWorkoutSchema).min(1).max(MAX_WORKOUTS_PER_BATCH),
});

export type CreateBatchWorkoutInput = z.infer<typeof createBatchWorkoutSchema>;
