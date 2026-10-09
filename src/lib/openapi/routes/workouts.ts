/**
 * OpenAPI route table — workouts list/detail/batch.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Schemas come from `src/lib/validations/*` where shared with the
 * runtime request parsing, so the wire contract stays single-source.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
import {
  MODULE_DISABLED_DESCRIPTION,
  createBatchWorkoutSchema,
  dataEnvelope,
  errorEnvelope,
  idempotencyKeyParameter,
  idempotentWrite,
  measurementSourceEnum,
  moduleDisabledResponse,
  recordRefusal,
  stdResponses,
} from "./shared";
import { aiCapabilityState } from "./profile";

// v1.4.25 W16b — typed workout batch ingest response envelope. Mirrors
// the measurements batch shape but reports the `workouts` count rather
// than the entries count. `skipped` carries the entries the server
// refused: an unusable external id, or a `samples` array that failed
// validation (`reason: "invalid_samples"`).
//
// `enriched` says the entry matched a stored workout that had no
// heart-rate series and the series it carried was attached. The
// workout row itself was not written, so such an entry also counts
// towards `duplicates`. That rule is part of the published contract,
// not just a note here: it rides the field descriptions below, because
// a client summing the counters has to know which bucket an
// enrichment lands in.
const workoutBatchEntryResult = z
  .object({
    index: z.number().int().nonnegative(),
    status: z
      .enum(["inserted", "duplicate", "enriched", "updated", "skipped"])
      .describe(
        "`inserted`: a new workout row. `duplicate`: the workout was already stored and nothing was written. `enriched`: the workout was already stored and the heart-rate series this entry carried was attached to it; the workout row itself was not written, and the entry also counts towards the top-level `duplicates`. `updated` (since v1.40.0): a workout entered by hand (`source: MANUAL`, `externalId` starting `manual:`) was sent again with different values and the stored row now carries them; no row was inserted, so it also counts towards `duplicates`. `skipped`: the server refused the entry, see `reason`.",
      ),
    reason: z
      .string()
      .optional()
      .describe(
        "Why a `skipped` entry was refused: `unstable_external_id` for an id that does not survive a client restart, `invalid_samples` for a heart-rate series that failed validation.",
      ),
  })
  .meta({ id: "WorkoutBatchEntryResult" });

const workoutBatchResponse = z
  .object({
    processed: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Entries in the request. Equals `inserted + duplicates + skipped.length`.",
      ),
    inserted: z
      .number()
      .int()
      .nonnegative()
      .describe("Workout rows this request wrote."),
    duplicates: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Entries that wrote no workout row because the workout was already stored. The top-level counters count workout rows, so an entry reported as `enriched` counts here as well even though its heart-rate series was attached.",
      ),
    skipped: z.array(
      z.object({
        index: z.number().int().nonnegative(),
        reason: z.string(),
      }),
    ),
    entries: z.array(workoutBatchEntryResult),
  })
  .meta({ id: "WorkoutBatchResponse" });

// v1.4.32 — workout list / detail wire shape. The field names follow
// the iOS handoff contract (`distanceM` + `activeEnergyKcal`) rather
// than the Prisma column names so iOS and web consumers share one
// JSON envelope.
const workoutListEntry = z
  .object({
    id: z.string(),
    // v1.37.19 — these four are nullable to match the DTO (list-read.ts
    // passes them through from nullable columns): an externally-synced
    // session can arrive without a sport type or timing. Declaring them
    // non-null was a strict-decoder bomb for the Swift client.
    sportType: z.string().nullable(),
    startedAt: z.iso.datetime({ offset: true }).nullable(),
    endedAt: z.iso.datetime({ offset: true }).nullable(),
    durationSec: z.number().int().nonnegative().nullable(),
    distanceM: z.number().nullable(),
    activeEnergyKcal: z.number().nullable(),
    avgHr: z.number().int().nullable(),
    maxHr: z.number().int().nullable(),
    source: measurementSourceEnum,
    externalId: z.string().nullable(),
    // #67 list glyphs — flags which sessions open into a rich detail.
    hasRoute: z.boolean(),
    hasHrSeries: z.boolean(),
  })
  .meta({ id: "WorkoutListEntry" });

const workoutListResponse = z
  .object({
    workouts: z.array(workoutListEntry),
    meta: z.object({
      total: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
      offset: z.number().int().nonnegative(),
      droppedDuplicates: z.number().int().nonnegative(),
    }),
  })
  .meta({ id: "WorkoutListResponse" });

const workoutRouteGeometry = z
  .object({
    geometry: z.unknown(),
    sampleTimestamps: z.array(z.string()).nullable(),
  })
  .meta({ id: "WorkoutRouteGeometry" });

// v1.10.0 — route-independent per-workout heart-rate series. Present
// for indoor and outdoor workouts that shipped a `samples` array on
// ingest. `samples` mirrors the ingest shape `[{ t, hr?, speedMs?,
// power?, cadence? }]`; `sampleCount` is the denormalised length.
const workoutHrSeries = z
  .object({
    sampleCount: z.number().int().nonnegative(),
    samples: z.unknown(),
  })
  .meta({ id: "WorkoutHrSeries" });

// #67 — per-workout HR curve, one DTO with explicit provenance. Stored
// `WorkoutSamples` series first, raw PULSE-window reconstruction second.
const workoutHrCurve = z
  .object({
    source: z.enum(["workout_series", "pulse_window"]),
    bucketSec: z.number().int().positive(),
    points: z.array(
      z.object({
        tSec: z.number().int().nonnegative(),
        mean: z.number().int(),
        min: z.number().int(),
        max: z.number().int(),
      }),
    ),
    envelope: z.boolean(),
  })
  .meta({ id: "WorkoutHrCurve" });

// #67 — effort-zone distribution. WHOOP device durations win; else a
// %HRmax fold from the HR curve when profile age exists.
const workoutZones = z
  .object({
    model: z.enum(["whoop", "tanaka"]),
    hrMax: z.number().int().nullable(),
    zones: z.array(
      z.object({
        zone: z.number().int().min(1).max(5),
        lowBpm: z.number().int().nullable(),
        highBpm: z.number().int().nullable(),
        seconds: z.number().int().nonnegative(),
      }),
    ),
  })
  .meta({ id: "WorkoutZones" });

// #67 — per-kilometre splits, derived server-side from geometry +
// timestamps so the raw timestamp blob can be dropped under `compact=1`.
const workoutSplit = z
  .object({
    km: z.number().int().positive(),
    durationSec: z.number().int().nonnegative(),
    paceSecPerKm: z.number().int().nonnegative(),
  })
  .meta({ id: "WorkoutSplit" });

// #67 — own-history average for the sport (comparison line).
const workoutSportContext = z
  .object({
    count: z.number().int().nonnegative(),
    avgDurationSec: z.number().int().nonnegative(),
    avgDistanceM: z.number().nullable(),
    avgAvgHr: z.number().int().nullable(),
  })
  .meta({ id: "WorkoutSportContext" });

const workoutActivityInsight = z
  .object({
    /** Plain text. No markup of any kind — clients render it as text. */
    paragraph: z.string(),
    generatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({ id: "WorkoutActivityInsight" });

const workoutDetailResponse = z
  .object({
    id: z.string(),
    sportType: z.string(),
    startedAt: z.iso.datetime({ offset: true }),
    endedAt: z.iso.datetime({ offset: true }),
    /**
     * The local calendar day the session belongs to, `YYYY-MM-DD`, resolved
     * server-side from `startedAt` in the user's timezone. Clients address
     * the day-scoped reads with it instead of deriving a day from the
     * timestamp in their own zone.
     */
    dayKey: z.string(),
    durationSec: z.number().int().nonnegative(),
    distanceM: z.number().nullable(),
    activeEnergyKcal: z.number().nullable(),
    avgHr: z.number().int().nullable(),
    maxHr: z.number().int().nullable(),
    minHr: z.number().int().nullable(),
    storedAvgHr: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe(
        "The row's own average heart rate (v1.42). `avgHr` may be filled in from a same-session twin by the canonical picker; this is the stored value, which an edit of a hand-entered workout sends back so the twin's value is not written onto it.",
      ),
    storedMaxHr: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe(
        "The row's own maximum heart rate (v1.42), as `storedAvgHr` is to `avgHr`.",
      ),
    stepCount: z.number().int().nullable(),
    elevationM: z.number().nullable(),
    pauseDurationSec: z.number().int().nullable(),
    source: measurementSourceEnum,
    externalId: z.string().nullable(),
    metadata: z.unknown().nullable(),
    route: workoutRouteGeometry.nullable(),
    samples: workoutHrSeries.nullable(),
    // #67 enrichment — additive; absent from a pre-enrichment client's
    // expectations, opt-in `compact=1` only trims the raw blobs above.
    hrSeries: workoutHrCurve.nullable(),
    zones: workoutZones.nullable(),
    splits: z.array(workoutSplit).nullable(),
    sportContext: workoutSportContext.nullable(),
    // The per-workout Activity Insight. Additive-nullable and overwhelmingly
    // null: a paragraph exists only for a workout that landed while the
    // feature was live, over the duration floor, under the day's cap and with
    // a provider reachable. Reading this endpoint never generates one.
    aiInsight: workoutActivityInsight.nullable(),
    ai: aiCapabilityState.describe(
      "The `workoutInsights` AI capability. While it is unavailable `aiInsight` is null and the stored paragraph is not even read.",
    ),
    canonicalId: z.string(),
    /**
     * The canonical session before this one in the same sport, or null when
     * this is the first on record. Resolved through the same source-priority
     * picker as the list, so the id always addresses a row the list shows.
     */
    previousWorkoutId: z.string().nullable(),
  })
  .meta({ id: "WorkoutDetailResponse" });

export const workoutPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/workouts": {
    get: {
      tags: ["Measurements"],
      summary: "List workouts (v1.4.32)",
      description:
        "Paginated workout list with cross-source canonical-row dedup. The picker reads the per-user source-priority ladder and buckets by `(startedAt 5 min slot, sportType)` — twin workouts (Apple Watch + Withings ScanWatch) collapse to a single canonical row per cluster. Field names mirror the iOS handoff contract: `distanceM`, `activeEnergyKcal`, `avgHr`, `maxHr`.",
      requestParams: {
        query: z.object({
          limit: z.coerce.number().int().min(1).max(200).optional(),
          offset: z.coerce.number().int().min(0).optional(),
          since: z.iso.datetime({ offset: true }).optional(),
          until: z.iso.datetime({ offset: true }).optional(),
          sportType: z.string().optional(),
        }),
      },
      responses: {
        "200": {
          description: "Canonical workout page.",
          content: {
            "application/json": {
              schema: dataEnvelope(workoutListResponse, "ListWorkoutsResponse"),
            },
          },
        },
        ...recordRefusal(MODULE_DISABLED_DESCRIPTION),
        ...stdResponses,
      },
    },
  },
  "/api/workouts/{id}": {
    get: {
      tags: ["Measurements"],
      summary: "Workout detail (v1.4.32)",
      description:
        "Single-workout envelope. Owns the optional `WorkoutRoute` GeoJSON geometry + `canonicalId` pointer that resolves to the cluster winner so deep-links into non-canonical twin rows can redirect cleanly. Additive enrichment fields (`hrSeries`, `zones`, `splits`, `sportContext`) are computed server-side. `aiInsight` is a pure read of a per-workout paragraph written by a background job when the workout landed; it is null for every workout that predates the feature or was re-synced, and while the `workoutInsights` AI capability is unavailable (`ai` says why), and reading this endpoint never generates one. `compact=1` (sent by the web client) drops the raw `samples.samples` HR blob and `route.sampleTimestamps` array from the response; without it the payload is byte-identical to the v1.4.32 contract. Cross-user rows surface as 404 (existence channel sealed).",
      requestParams: {
        path: z.object({ id: z.string() }),
        query: z.object({
          compact: z.enum(["1"]).optional(),
        }),
      },
      responses: {
        "200": {
          description: "Workout detail.",
          content: {
            "application/json": {
              schema: dataEnvelope(workoutDetailResponse, "GetWorkoutResponse"),
            },
          },
        },
        "404": {
          description: "Workout not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...moduleDisabledResponse,
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Measurements"],
      summary: "Delete a workout entered by hand",
      description:
        "Removes a `MANUAL` workout outright, with its child rows, and any personal record that workout set; a silent detection pass then re-derives the previous best. A workout from any other source answers 409 (`workout.delete.synced_source`), because the next sync would write it back. Own record only: a cookie session or a wildcard token. Another user's row answers 404.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        "200": {
          description: "Deleted.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ deleted: z.literal(true) }),
                "DeleteWorkoutResponse",
              ),
            },
          },
        },
        "404": {
          description: "Workout not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description:
            "The workout was synced from a device or service, not entered by hand.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/workouts/batch": {
    post: {
      parameters: [idempotencyKeyParameter],
      tags: ["Measurements"],
      summary: "Typed workout batch ingest (v1.4.25 W16b)",
      description:
        'Server-side ingest endpoint for HKWorkout records (iOS) and Withings activity rows (server-to-server). Up to 100 workouts per call; nested route geometry (GeoJSON LineString) is capped at 20 000 points and stored in a 1:1 `WorkoutRoute` row keyed by `workoutId`. Idempotent via the `Idempotency-Key` header (replay window 24h). Per-entry status (`inserted | duplicate | enriched | updated | skipped`) lets the iOS sync cursor checkpoint accurately. An entry matching a stored workout is first-write-wins for the workout row, except a hand-entered one (`source: MANUAL` with a `manual:` externalId), which a resend with other values overwrites and reports `updated`; when it carries a `samples` array and the stored workout has no heart-rate series, the series is attached and the entry reports `enriched` (repeatable: a workout that already has a series is a no-op). An entry whose `samples` array fails validation is refused on its own with `reason: "invalid_samples"` — the rest of the batch still lands. The request body ceiling is 5 MB enforced at the HTTP layer — clients above the ceiling receive a 413 with `workout.batch.payload_too_large`.\n\n' +
        "**Narrow token.** Also reachable with a `workouts:write` Bearer (minted at `POST /api/tokens/workouts`), the supported way to push workouts from a bridge that is not the phone. This route is the scope's only one. Such a credential writes only on its owner's own record; its workouts are attributed `EXTERNAL`, resolved from the credential, and it may not name a source itself, so a batch in which any entry carries one, `MANUAL` and `APPLE_HEALTH` alike, is refused 422 (`workout.batch.source_not_permitted`) and nothing is written. `EXTERNAL` gives those writes their own `(userId, source, externalId)` namespace, so a bridge's ids can never collide with the phone's. Every other narrow token, `measurements:write` included, is refused 403.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: createBatchWorkoutSchema } },
      },
      responses: {
        ...idempotentWrite(),
        "200": {
          description: "Batch processed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                workoutBatchResponse,
                "BatchWorkoutsResponse",
              ),
            },
          },
        },
        "400": {
          description:
            "Batch validation failed (over-cap, schema reject, or oversized route).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "413": {
          description: "Request body exceeds the 5 MB ceiling.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        // After the spread: `stdResponses` carries a generic 422 that would
        // otherwise overwrite this wording.
        "422": {
          description:
            "A narrow `workouts:write` credential sent a batch in which an entry names a source, any source (`workout.batch.source_not_permitted`). Nothing was written; resending the batch unchanged is refused the same way. Omit `source` and the server attributes the rows `EXTERNAL`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
};
