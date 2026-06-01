/**
 * OpenAPI route table — populated incrementally.
 *
 * v1.4.23 baseline covers the routes the v1.5 iOS app touches end-to-end:
 *   - POST /api/auth/login
 *   - POST /api/auth/passkey/login-verify
 *   - POST /api/auth/refresh
 *   - GET  /api/measurements
 *   - POST /api/measurements
 *   - POST /api/measurements/batch    (W2 — Apple Health ingest)
 *   - POST /api/devices               (W3 — APNs registration)
 *   - GET  /api/insights/comprehensive
 *
 * Schemas come from `src/lib/validations/*` so the wire contract stays
 * single-source-of-truth. The `.meta()` annotations on each schema land
 * the title + description in `components.schemas.*` automatically.
 *
 * Routes are intentionally registered as inline operation objects
 * rather than via a wrapping helper — `zod-openapi`'s `createDocument`
 * type-checks the route table directly, which catches schema-shape
 * regressions at typecheck time.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import {
  createMeasurementSchema,
  listMeasurementsSchema,
  measurementTypeEnum,
  measurementSourceEnum,
} from "@/lib/validations/measurement";
import { loginPasswordSchema } from "@/lib/validations/auth";
import { coachPrefsSchema } from "@/lib/validations/coach-prefs";
import {
  deviceTypeEnum,
  sourcePrioritySchema,
} from "@/lib/validations/source-priority";
import { createBatchWorkoutSchema } from "@/lib/validations/workout";
import {
  createMedicationSchema,
  updateMedicationSchema,
  intakeSchema,
  MEDICATION_CATEGORY_VALUES,
  MEDICATION_TREATMENT_CLASS_VALUES,
} from "@/lib/validations/medication";
import { medicationExtractionSchema } from "@/lib/ai/coach/medication-extract-prompt";
import { ACCEPTED_INSIGHTS_TILE_IDS } from "@/lib/insights-layout";
import { exportSelectionSchema } from "@/lib/validations/health-record-export";

/**
 * Common envelopes — every HealthLog API response wraps payload in
 * `{ data, error, meta? }`. The OpenAPI surface mirrors that contract
 * so iOS / external-ingest clients can decode uniformly.
 */
const errorEnvelope = z
  .object({
    data: z.null(),
    error: z.string(),
    meta: z
      .object({
        requestId: z.string().optional(),
        errorCode: z.string().optional(),
      })
      .optional(),
  })
  .meta({
    id: "ErrorEnvelope",
    description: "Standard error response: data is null, error is human prose.",
  });

function dataEnvelope<T extends z.ZodType>(payload: T, id: string) {
  return z
    .object({
      data: payload,
      error: z.null(),
      meta: z.object({ requestId: z.string().optional() }).optional(),
    })
    .meta({ id });
}

// ── Schemas — annotated for spec emission ────────────────────────────

measurementTypeEnum.meta({
  id: "MeasurementType",
  description:
    "DB-stored measurement category. v1.4.23 added 7 Apple Health values (HRV, resting HR, active energy, flights, walking/running distance, VO2 max, body temperature).",
});

measurementSourceEnum.meta({
  id: "MeasurementSource",
  description:
    "Origin of the measurement. v1.4.23 added APPLE_HEALTH for the iOS HealthKit batch ingest path.",
});

loginPasswordSchema.meta({
  id: "LoginPasswordRequest",
  description:
    "Email-or-username login. The native-client flow returns a paired access + refresh token when X-Client-Type: native or the iOS UA prefix is present.",
});

createMeasurementSchema.meta({
  id: "CreateMeasurementRequest",
  description:
    "Single-measurement ingest body. Plausibility-range guard runs server-side; out-of-range values fail 422.",
});

listMeasurementsSchema.meta({
  id: "ListMeasurementsQuery",
  description:
    "Query params for the measurements list endpoint. `limit` capped at 500.",
});

coachPrefsSchema.meta({
  id: "CoachPrefs",
  description:
    "Per-user Coach prompt-tuning preferences (v1.4.23 H4). All fields default to the legacy v1.4.22 behaviour when omitted.",
});

createBatchWorkoutSchema.meta({
  id: "CreateBatchWorkoutRequest",
  description:
    "v1.4.25 W16b — typed workout batch ingest. Each entry is an HKWorkout-aligned record with an optional nested GeoJSON LineString route. Up to 100 workouts per call; nested route geometry capped at 20 000 points. Withings server-to-server callers pass source: WITHINGS and ship no route (Withings reports aggregates only).",
});

const coachMessageFeedbackBody = z
  .object({
    rating: z.enum(["helpful", "unhelpful"]),
    reason: z.string().min(1).max(200).optional(),
  })
  .meta({
    id: "CoachMessageFeedbackRequest",
    description:
      "Per-message helpful/unhelpful feedback (v1.4.23 H7). Optional `reason` is free-form prose, capped at 200 chars.",
  });

// v1.4.49 — single schema for the per-user Coach opt-out flag. Previously
// split into `disableCoachBody` (PATCH request) and `disableCoachData`
// (response payload), both `z.object({ disableCoach: z.boolean() })`. The
// payload was passed through `dataEnvelope(..., "GetDisableCoachResponse")`
// / `dataEnvelope(..., "PatchDisableCoachResponse")` which IDs the
// envelope wrapper — the inner flag carries its own `.meta()` and now
// renders as a single `$ref: "#/components/schemas/DisableCoachFlag"` in
// both the request body and both response envelopes.
const disableCoachFlag = z
  .object({
    disableCoach: z.boolean(),
  })
  .meta({
    id: "DisableCoachFlag",
    description:
      "Per-account Coach opt-out toggle (v1.4.47 W3). `true` hides the Coach FAB and short-circuits its API gates.",
  });

// ── Sub-schemas owned here (route-specific shapes) ───────────────────

const passkeyLoginVerifyRequest = z
  .object({
    challengeId: z
      .string()
      .min(1)
      .describe("Server-issued WebAuthn challenge id."),
    credential: z
      .object({
        id: z.string(),
        rawId: z.string(),
        type: z.literal("public-key"),
        response: z.record(z.string(), z.unknown()),
        authenticatorAttachment: z
          .enum(["platform", "cross-platform"])
          .optional(),
        clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
      })
      .describe("SimpleWebAuthn-style assertion response payload."),
  })
  .meta({
    id: "PasskeyLoginVerifyRequest",
    description:
      "Passkey assertion verification. Same native-client token issuance as the password path.",
  });

const refreshRequest = z
  .object({
    refreshToken: z
      .string()
      .min(1)
      .describe("Caller-presented refresh token (`hlr_<64hex>`)."),
    revoke: z
      .boolean()
      .optional()
      .describe("When true, revoke the supplied token instead of rotating."),
  })
  .meta({
    id: "RefreshTokenRequest",
    description:
      "Exchange a one-time-use refresh token for a fresh access + refresh pair.",
  });

const accessRefreshBundle = z
  .object({
    user: z.object({ id: z.string(), username: z.string() }).optional(),
    token: z.string().describe("Access token (`hlk_<64hex>`)."),
    tokenExpiresAt: z.iso.datetime({ offset: true }),
    refreshToken: z
      .string()
      .optional()
      .describe(
        "Refresh token (`hlr_<64hex>`); only present for native-policy callers.",
      ),
    refreshTokenExpiresAt: z.iso.datetime({ offset: true }).optional(),
  })
  .meta({
    id: "AccessRefreshBundle",
    description:
      "Native-client token bundle returned by login + refresh. Web cookie-only callers see only `user`.",
  });

const deviceRegisterRequest = z
  .object({
    token: z
      .string()
      .min(8)
      .max(512)
      .regex(/^[A-Za-z0-9+/=._:-]+$/)
      .describe("Generic device identifier (legacy; APNs token below)."),
    bundleId: z.string().min(1).max(128),
    locale: z.string().min(2).max(16).optional(),
    appVersion: z.string().min(1).max(32).optional(),
    model: z.string().min(1).max(64).optional(),
    apnsToken: z
      .string()
      .min(8)
      .max(256)
      .regex(/^[A-Fa-f0-9]+$/)
      .optional()
      .describe(
        "Hex-encoded APNs device token. Must be paired with `apnsEnvironment`.",
      ),
    apnsEnvironment: z
      .enum(["sandbox", "production"])
      .optional()
      .describe(
        "Gateway the iOS client received `apnsToken` from. Server never auto-detects.",
      ),
    medicationDelivery: z
      .enum(["server", "client"])
      .nullable()
      .optional()
      .describe(
        "v1.7.0 per-device medication-delivery override. NULL / omitted = inherit the user-level roaming default. \"server\" forces server APNs for this device; \"client\" forces local. Stored + echoed; cron suppression stays user-level.",
      ),
  })
  .meta({
    id: "DeviceRegisterRequest",
    description:
      "Native device registration. Re-registering an APNs token belonging to another user returns 409 (cross-user-hijack guard).",
  });

const batchEntrySchema = z
  .object({
    hkIdentifier: z
      .string()
      .min(1)
      .max(120)
      .describe(
        "HealthKit identifier (e.g. `HKQuantityTypeIdentifierBodyMass`).",
      ),
    value: z.number().finite(),
    unit: z.string().min(1).max(60),
    startDate: z.iso.datetime({ offset: true }),
    endDate: z.iso.datetime({ offset: true }),
    sleepStage: z
      .number()
      .int()
      .min(0)
      .max(20)
      .optional()
      .describe(
        "HKCategoryValueSleepAnalysis codepoint; only for sleep samples.",
      ),
    externalId: z
      .string()
      .min(1)
      .max(120)
      .describe("HKSample.uuid string — the dedup key."),
    externalSourceVersion: z.string().min(1).max(120).optional(),
    // v1.4.25 W8c — optional device-type tag fed into the canonical
    // source picker's second axis. NULL is treated as `unknown`;
    // legacy iOS builds that don't ship the field continue to work.
    deviceType: deviceTypeEnum
      .nullable()
      .optional()
      .describe(
        "Device class mapped from `HKDevice.model`. Used by the analytics aggregator to break ties when the same source contributed multiple devices for the same day. Omit (or send null) on legacy clients — the server treats it as `unknown` and the picker falls through.",
      ),
  })
  .meta({ id: "AppleHealthBatchEntry" });

const batchPayloadSchema = z
  .object({
    entries: z.array(batchEntrySchema).min(1).max(500),
  })
  .meta({
    id: "AppleHealthBatchRequest",
    description:
      "Apple Health batch ingest. ≤500 entries per call; idempotent via `Idempotency-Key`.",
  });

const batchEntryResult = z
  .object({
    index: z.number().int().nonnegative(),
    status: z.enum(["inserted", "duplicate", "skipped"]),
    reason: z.string().optional(),
  })
  .meta({ id: "AppleHealthBatchEntryResult" });

const batchResponse = z
  .object({
    inserted: z.number().int().nonnegative(),
    duplicate: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    entries: z.array(batchEntryResult),
  })
  .meta({ id: "AppleHealthBatchResponse" });

// v1.4.25 W16b — typed workout batch ingest response envelope. Mirrors
// the measurements batch shape but reports the `workouts` count rather
// than the entries count, and the `skipped` field is reserved (the
// Zod schema rejects malformed entries with a 400 before the per-entry
// pass, so today's responses always carry an empty array).
const workoutBatchEntryResult = z
  .object({
    index: z.number().int().nonnegative(),
    status: z.enum(["inserted", "duplicate", "skipped"]),
    reason: z.string().optional(),
  })
  .meta({ id: "WorkoutBatchEntryResult" });

const workoutBatchResponse = z
  .object({
    processed: z.number().int().nonnegative(),
    inserted: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
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
    sportType: z.string(),
    startedAt: z.iso.datetime({ offset: true }),
    endedAt: z.iso.datetime({ offset: true }),
    durationSec: z.number().int().nonnegative(),
    distanceM: z.number().nullable(),
    activeEnergyKcal: z.number().nullable(),
    avgHr: z.number().int().nullable(),
    maxHr: z.number().int().nullable(),
    source: measurementSourceEnum,
    externalId: z.string().nullable(),
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

const workoutDetailResponse = z
  .object({
    id: z.string(),
    sportType: z.string(),
    startedAt: z.iso.datetime({ offset: true }),
    endedAt: z.iso.datetime({ offset: true }),
    durationSec: z.number().int().nonnegative(),
    distanceM: z.number().nullable(),
    activeEnergyKcal: z.number().nullable(),
    avgHr: z.number().int().nullable(),
    maxHr: z.number().int().nullable(),
    minHr: z.number().int().nullable(),
    stepCount: z.number().int().nullable(),
    elevationM: z.number().nullable(),
    pauseDurationSec: z.number().int().nullable(),
    source: measurementSourceEnum,
    externalId: z.string().nullable(),
    metadata: z.unknown().nullable(),
    route: workoutRouteGeometry.nullable(),
    canonicalId: z.string(),
  })
  .meta({ id: "WorkoutDetailResponse" });

const deleteByExternalIdsRequest = z
  .object({
    externalIds: z.array(z.string().min(1).max(120)).min(0).max(500),
  })
  .meta({
    id: "MeasurementsDeleteByExternalIdsRequest",
    description:
      "iOS deletion-sync. Up to 500 externalIds per call; matching rows owned by other users are silently skipped (cross-user 404 guard).",
  });

const deleteByExternalIdsResponse = z
  .object({
    deletedCount: z.number().int().nonnegative(),
  })
  .meta({ id: "MeasurementsDeleteByExternalIdsResult" });

const measurementResource = z
  .object({
    id: z.string(),
    type: measurementTypeEnum,
    value: z.number(),
    unit: z.string(),
    measuredAt: z.iso.datetime({ offset: true }),
    source: measurementSourceEnum,
    notes: z.string().nullable().optional(),
  })
  .meta({
    id: "MeasurementResource",
    description: "Server-shaped measurement row returned by GET endpoints.",
  });

// ── Sync (v1.7.0 offline / server-optional) ─────────────────────────

const syncStateResponse = z
  .object({
    userId: z.string(),
    timezone: z.string(),
    lastSyncedAt: z.iso.datetime({ offset: true }).nullable(),
    serverNow: z.iso.datetime({ offset: true }),
    measurements: z.object({
      lastUpdatedAt: z.iso.datetime({ offset: true }).nullable(),
      liveCount: z.number().int().nonnegative(),
      tombstonedCount: z.number().int().nonnegative(),
    }),
    mood: z.object({
      lastUpdatedAt: z.iso.datetime({ offset: true }).nullable(),
      liveCount: z.number().int().nonnegative(),
      tombstonedCount: z.number().int().nonnegative(),
    }),
    intakes: z.object({
      lastUpdatedAt: z.iso.datetime({ offset: true }).nullable(),
      liveCount: z.number().int().nonnegative(),
      tombstonedCount: z.number().int().nonnegative(),
    }),
    sync: z
      .object({
        incrementalWindowDays: z
          .number()
          .int()
          .positive()
          .describe(
            "Days an incremental delta stays valid; tracks the native refresh-token lifetime. Beyond it a device re-pairs with a full backfill. iOS derives its window from this rather than hardcoding 60.",
          ),
        tombstoneRetentionDays: z
          .number()
          .int()
          .positive()
          .describe(
            "Horizon past which tombstones may be pruned. A cursor older than this gets `cursorExpired` on `/api/sync/changes`.",
          ),
      })
      .describe("Sync-window metadata the client reads instead of hardcoding."),
  })
  .meta({
    id: "SyncStateResponse",
    description:
      "iOS SyncMode handshake. Each GET also advances the server-side `lastSyncedAt` checkpoint and returns the previous value. The cheap 'should I sync?' summary; the durable delta cursor lives on `/api/sync/changes`.",
  });

const syncMeasurementUpsert = measurementResource
  .extend({
    externalId: z
      .string()
      .nullable()
      .describe("Cross-device dedup key (UUID string or `stats:<id>:<date>`)."),
    syncVersion: z
      .number()
      .int()
      .positive()
      .describe("LWW reconciliation counter; echo to keep the mirror monotonic."),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({ id: "SyncMeasurementUpsert" });

const syncMeasurementTombstone = z
  .object({
    id: z.string(),
    externalId: z
      .string()
      .nullable()
      .describe("The identity key the client dedups on for measurements."),
    syncVersion: z.number().int().positive(),
    deletedAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "SyncMeasurementTombstone",
    description:
      "A soft-deleted measurement. Apply tombstones BEFORE upserts within a page to avoid resurrecting a row.",
  });

const syncMoodUpsert = z
  .object({
    id: z.string(),
    date: z.string().describe("YYYY-MM-DD anchored to the row's `tz`."),
    mood: z.string(),
    score: z.number().int(),
    tags: z.string().nullable().describe("JSON array of tag keys, or null."),
    note: z.string().nullable(),
    moodLoggedAt: z.iso.datetime({ offset: true }),
    source: z.string(),
    syncVersion: z
      .number()
      .int()
      .nonnegative()
      .describe("LWW reconciliation counter; mood is last-writer-wins by it."),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({ id: "SyncMoodUpsert" });

const syncMoodTombstone = z
  .object({
    id: z.string().describe("Server id — the identity key the client dedups on for mood."),
    syncVersion: z.number().int().nonnegative(),
    deletedAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "SyncMoodTombstone",
    description:
      "A soft-deleted mood entry, keyed on server `id`. Apply before upserts within the domain page.",
  });

const syncIntakeUpsert = z
  .object({
    id: z.string(),
    medicationId: z.string(),
    scheduledFor: z.iso.datetime({ offset: true }),
    takenAt: z.iso.datetime({ offset: true }).nullable(),
    skipped: z.boolean(),
    source: z.string(),
    syncVersion: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Reconciliation counter. An intake is immutable; a correction is a tombstone + re-insert.",
      ),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({ id: "SyncIntakeUpsert" });

const syncIntakeTombstone = z
  .object({
    id: z.string().describe("Server id — the identity key the client dedups on for intakes."),
    syncVersion: z.number().int().nonnegative(),
    deletedAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "SyncIntakeTombstone",
    description:
      "A soft-deleted medication intake, keyed on server `id`. Apply before upserts within the domain page.",
  });

const syncChangesQuery = z
  .object({
    cursor: z
      .string()
      .min(1)
      .max(2048)
      .optional()
      .describe(
        "Opaque multi-domain keyset cursor from the previous page. Treat as fully opaque — echo, never parse. Omit for the initial sync.",
      ),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe("Page size, default 200, hard cap 500."),
  })
  .meta({ id: "SyncChangesQuery" });

const syncChangesResponse = z
  .object({
    serverNow: z.iso.datetime({ offset: true }),
    cursor: z
      .string()
      .nullable()
      .describe("Opaque cursor to echo into the next request."),
    hasMore: z
      .boolean()
      .describe("False once the client is caught up as of `serverNow`."),
    cursorExpired: z
      .boolean()
      .describe(
        "True when the supplied cursor predates tombstone retention — drop the cursor and do a clean initial sync.",
      ),
    changes: z.object({
      measurements: z.object({
        upserts: z.array(syncMeasurementUpsert),
        tombstones: z.array(syncMeasurementTombstone),
      }),
      mood: z.object({
        upserts: z.array(syncMoodUpsert),
        tombstones: z.array(syncMoodTombstone),
      }),
      intakes: z.object({
        upserts: z.array(syncIntakeUpsert),
        tombstones: z.array(syncIntakeTombstone),
      }),
    }),
  })
  .meta({
    id: "SyncChangesResponse",
    description:
      "Multi-domain delta page (v1.7.0): measurements + mood + intakes. One opaque multi-domain keyset cursor; tombstones apply before upserts within each domain. Tombstone identity: measurements key on externalId, mood + intakes on server id. The iOS consumer is measurements-only this cycle; mood + intakes are forward-prep.",
  });

// v1.4.48 H-APNs-1 — admin diagnostic endpoint for the notification
// subsystem. Mirrors the runtime types in
// `src/app/api/admin/notifications/diagnostic/route.ts`: APNs tokens
// are surfaced only as 8-char hex prefix + suffix (never the full
// token), per-channel `enabled` + `configPresent` booleans, and a
// `recentPushAttempts` array reserved for the v1.4.48+ follow-up that
// adds the dedicated PushAttempt table (currently always `[]` so the
// shape stays stable for iOS consumers).
const adminDiagnosticDevice = z
  .object({
    id: z.string(),
    platform: z.string(),
    hasApnsToken: z.boolean(),
    apnsTokenPrefix: z.string().nullable(),
    apnsTokenSuffix: z.string().nullable(),
    apnsEnvironment: z.string().nullable(),
    lastSeenAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "AdminDiagnosticDevice",
    description:
      "Per-device APNs registration snapshot. The APNs token is masked to its 8-char hex prefix + 8-char suffix so an operator can correlate with iOS-side logs without disclosing the delivery target.",
  });

const adminDiagnosticChannel = z
  .object({
    type: z.string(),
    enabled: z.boolean(),
    configPresent: z.boolean(),
  })
  .meta({
    id: "AdminDiagnosticChannel",
    description:
      "Per-channel state. `configPresent` is true when the channel's encrypted-JSON config blob carries the field the corresponding sender will read (chatId+botToken for TELEGRAM, topic for NTFY); WEB_PUSH/APNS rely on sibling tables so the row's existence is the signal.",
  });

const adminDiagnosticPushAttempt = z
  .object({
    eventType: z.string(),
    channel: z.string(),
    result: z.string(),
    reason: z.string().nullable(),
    at: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "AdminDiagnosticPushAttempt",
    description:
      "Single push delivery attempt. Reserved for the v1.4.48+ follow-up that adds the dedicated PushAttempt table — currently always returned as an empty array so the response shape stays stable for iOS consumers.",
  });

const adminDiagnosticData = z
  .object({
    devices: z.array(adminDiagnosticDevice),
    notificationChannels: z.array(adminDiagnosticChannel),
    recentPushAttempts: z.array(adminDiagnosticPushAttempt),
  })
  .meta({
    id: "AdminDiagnosticData",
    description:
      "Admin notification diagnostic snapshot for the calling user — what the dispatcher would see when targeting this account. Surfaces device tokens (masked), channel state, and recent push attempts so an operator can debug an iOS / Web Push / Telegram / ntfy issue without DB shell access.",
  });

// ── Medications (v1.5 scheduling) ────────────────────────────────────
//
// The Medication + MedicationSchedule resource shapes documented below
// follow the wire envelope the seven routes registered at the bottom of
// this file emit. `windowStart` / `windowEnd` / `daysOfWeek` /
// `intervalWeeks` are the legacy primitives kept for backwards
// compatibility through the v1.5.x line; `timesOfDay`, `rrule`,
// `rollingIntervalDays`, and `reminderGraceMinutes` are the v1.5
// first-class primitives the wizard + iOS cadence picker write. The
// XOR between `rrule` and `rollingIntervalDays` is documented at the
// schema description AND enforced by the route + a DB CHECK constraint
// so iOS code-gen surfaces the mutual exclusion.

const medicationCategoryEnum = z
  .enum(MEDICATION_CATEGORY_VALUES)
  .meta({
    id: "MedicationCategory",
    description:
      "Clinical taxonomy stored in the `medication_categories` side-table. Orthogonal to `MedicationTreatmentClass`.",
  });

const medicationTreatmentClassEnum = z
  .enum(MEDICATION_TREATMENT_CLASS_VALUES)
  .meta({
    id: "MedicationTreatmentClass",
    description:
      "Prisma-level treatment-class discriminator. `GLP1` unlocks the GLP-1 specialist surfaces (injection-site rotation, titration history, pen inventory, GLP-1-aware Coach).",
  });

const medicationScheduleResource = z
  .object({
    id: z.string(),
    medicationId: z.string(),
    windowStart: z
      .string()
      .describe(
        "Legacy single-time-of-intake (HH:mm, user local). Preserved for backwards compatibility; the new `timesOfDay` array supersedes it.",
      ),
    windowEnd: z
      .string()
      .describe(
        "Legacy reminder-window upper bound (HH:mm). Used to derive the late-classification grace span when `reminderGraceMinutes` is null.",
      ),
    label: z.string().nullable(),
    dose: z
      .string()
      .nullable()
      .describe(
        "Per-schedule dose override. NULL means the schedule inherits `Medication.dose`.",
      ),
    daysOfWeek: z
      .string()
      .nullable()
      .describe(
        "Legacy persisted recurrence encoding (`null` | `1,3,5` | `i2;1,3,5`). v1.5 readers consult `rrule` first; the field is kept for pre-v1.5 rows. v1.6.0 drops the column.",
      ),
    timesOfDay: z
      .array(z.string())
      .describe(
        "v1.5 first-class points-in-time the dose is taken (HH:mm, user local). Backfilled to `[windowStart]` for every pre-v1.5 row.",
      ),
    reminderGraceMinutes: z
      .number()
      .int()
      .nullable()
      .describe(
        "Reminder grace window in minutes. NULL falls back to the legacy `windowEnd - windowStart` span.",
      ),
    rrule: z
      .string()
      .nullable()
      .describe(
        "RFC 5545 RRULE string (subset). Used for calendar-anchored cadences. **Mutually exclusive with `rollingIntervalDays`** — exactly one of the two is non-null on any v1.5+ schedule (or both are null on legacy rows that haven't been touched since the migration).",
      ),
    rollingIntervalDays: z
      .number()
      .int()
      .nullable()
      .describe(
        "Flexible-rolling interval in days, counted forward from the latest `MedicationIntakeEvent.takenAt`. **Mutually exclusive with `rrule`.**",
      ),
    scheduleType: z
      .enum(["SCHEDULED", "PRN", "CYCLIC"])
      .describe(
        "v1.7.0 schedule-type discriminator. SCHEDULED = rrule / rolling / legacy cadence. PRN = as-needed (never projected, reminded, or counted in compliance expected; still loggable via the intake route). CYCLIC = N weeks on / M weeks off, gating whichever inner cadence the rrule / legacy fields describe.",
      ),
    cyclicOnWeeks: z
      .number()
      .int()
      .nullable()
      .describe(
        "v1.7.0 cyclic \"on\" weeks. Only meaningful when `scheduleType` is CYCLIC; null otherwise.",
      ),
    cyclicOffWeeks: z
      .number()
      .int()
      .nullable()
      .describe(
        "v1.7.0 cyclic \"off\" weeks. Only meaningful when `scheduleType` is CYCLIC; null otherwise.",
      ),
  })
  .meta({
    id: "MedicationSchedule",
    description:
      "Schedule entry attached to a medication. v1.5 promotes `timesOfDay` to first-class and introduces `rrule` (calendar-anchored cadences) and `rollingIntervalDays` (flexible-rolling cadences). The two recurrence primitives are mutually exclusive — enforced by the Zod refine on writes, the route layer, and a DB CHECK constraint (`medication_schedules_rrule_xor_rolling`). v1.7.0 adds `scheduleType` (SCHEDULED / PRN / CYCLIC) and the cyclic on/off-week fields.",
  });

const medicationResource = z
  .object({
    id: z.string(),
    name: z.string(),
    dose: z.string(),
    treatmentClass: medicationTreatmentClassEnum,
    dosesPerUnit: z
      .number()
      .int()
      .nullable()
      .describe(
        "Doses per pen / vial for inventory tracking. NULL = inventory tracking off.",
      ),
    active: z.boolean(),
    notificationsEnabled: z.boolean(),
    liveActivityEnabled: z
      .boolean()
      .describe(
        "v1.7.0 iOS Live Activity opt-in for this medication's reminders. Default false. The iOS client owns the ActivityKit lifecycle; the server only stores + echoes the flag.",
      ),
    criticalAlarmEnabled: z
      .boolean()
      .describe(
        "v1.7.0 iOS 26 AlarmKit critical-reminder opt-in. Default false. Critical alarms bypass the device mute switch / Focus; the server stores the preference only.",
      ),
    pausedAt: z.iso.datetime({ offset: true }).nullable(),
    snoozedUntil: z.iso.datetime({ offset: true }).nullable(),
    nextDueAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "v1.7.0 server-computed next due instant across all the medication's schedules (earliest `nextOccurrenceAfter`). Read-only — computed, not stored. NULL when no schedule has an upcoming slot (paused, one-shot in the past, `endsOn` crossed, every schedule PRN). The list GET is cached 60 s, so a 60 s staleness is accepted.",
      ),
    startsOn: z
      .iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "v1.5 course start (ISO date). Anchors RRULE BYDAY / BYMONTHDAY patterns and the rolling-interval countdown's first window. NULL means active from creation.",
      ),
    endsOn: z
      .iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "v1.5 course end (ISO date). NULL means chronic. Equals `startsOn` when `oneShot` is true.",
      ),
    oneShot: z
      .boolean()
      .describe(
        "v1.5 single-administration flag. When true the medication has at most one schedule (no `rrule` / `rollingIntervalDays`), and `active` auto-flips to false once the dose is logged.",
      ),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    schedules: z.array(medicationScheduleResource),
  })
  .meta({
    id: "Medication",
    description:
      "Server-shaped medication row returned by GET / POST / PUT endpoints. Carries the v1.5 course-window fields (`startsOn`, `endsOn`, `oneShot`) at the medication level and the per-schedule cadence fields on the nested `schedules` array.",
  });

const medicationListEntry = medicationResource
  .extend({
    category: medicationCategoryEnum,
    lastTakenAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "Latest non-skipped `MedicationIntakeEvent.takenAt` for the medication. Drives the rolling-cadence countdown surface.",
      ),
    todayEventCount: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Number of intake events scheduled for today (user-local day window).",
      ),
  })
  .meta({
    id: "MedicationListEntry",
    description:
      "List-row variant of the medication resource enriched with the joined `category`, `lastTakenAt`, and `todayEventCount` fields the dashboard + iOS client consume. The base medication fields (`id`, `name`, `dose`, `treatmentClass`, `dosesPerUnit`, `active`, `notificationsEnabled`, `pausedAt`, `snoozedUntil`, `startsOn`, `endsOn`, `oneShot`, `createdAt`, `updatedAt`, `schedules`) are inlined; see the `Medication` component for their semantics.",
  });

const medicationDetailEntry = medicationResource
  .extend({
    category: medicationCategoryEnum,
  })
  .meta({
    id: "MedicationDetail",
    description:
      "Detail variant of the medication resource enriched with the joined `category`. The base medication fields are inlined; see the `Medication` component for their semantics.",
  });

const medicationIntakeEventResource = z
  .object({
    id: z.string(),
    userId: z.string(),
    medicationId: z.string(),
    scheduledFor: z.iso.datetime({ offset: true }),
    takenAt: z.iso.datetime({ offset: true }).nullable(),
    skipped: z.boolean(),
    source: z.enum(["WEB", "API", "REMINDER", "IMPORT"]),
    idempotencyKey: z.string().nullable(),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "MedicationIntakeEvent",
    description:
      "Single dose log row. `takenAt` is non-null for confirmed intakes; `skipped:true` represents a deliberately-missed dose (no inventory consumption).",
  });

const medicationCadenceTimelinePoint = z
  .object({
    day: z.iso.datetime({ offset: true }),
    windowStart: z.iso.datetime({ offset: true }),
    windowEnd: z.iso.datetime({ offset: true }),
    scheduleIndex: z.number().int().nonnegative(),
    status: z.string(),
  })
  .meta({
    id: "MedicationCadenceTimelinePoint",
    description:
      "One expected-vs-actual dose slot for the cadence timeline chart. `status` is one of `taken | skipped | missed | pending | future` and drives the chip colour.",
  });

const medicationCadenceChips = z
  .object({
    adherenceRate: z.number(),
    streakDays: z.number().int().nonnegative(),
    expectedSlots: z.number().int().nonnegative(),
    actualDoses: z.number().int().nonnegative(),
  })
  .meta({
    id: "MedicationCadenceChips",
    description:
      "Four compliance summary values for the medication detail page chip row.",
  });

const medicationCadenceResponse = z
  .object({
    windowDays: z.number().int().positive(),
    anchorIso: z.iso.datetime({ offset: true }),
    next: z
      .object({
        windowStart: z.iso.datetime({ offset: true }),
        windowEnd: z.iso.datetime({ offset: true }),
        scheduleIndex: z.number().int().nonnegative(),
      })
      .nullable(),
    chips: medicationCadenceChips,
    timeline: z.array(medicationCadenceTimelinePoint),
  })
  .meta({
    id: "MedicationCadenceResponse",
    description:
      "Cadence + compliance read for a single medication. `next` is the upcoming-dose envelope (null when the course has ended or the rolling clock has no pinning intake yet); `timeline` walks the requested `windowDays` worth of slots in ascending time order.",
  });

const insightsComprehensiveResponse = z
  .object({
    summary: z.string(),
    recommendations: z.array(z.record(z.string(), z.unknown())),
    citations: z.array(z.record(z.string(), z.unknown())),
    warnings: z.array(z.record(z.string(), z.unknown())),
    dailyBriefing: z.record(z.string(), z.unknown()).nullable().optional(),
    trendAnnotations: z.record(z.string(), z.unknown()).nullable().optional(),
    storyboardAnnotations: z
      .array(z.record(z.string(), z.unknown()))
      .optional(),
    metricSource: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({
    id: "InsightsComprehensiveResponse",
    description:
      "AI-generated insights bundle. Strict-schema validated server-side; Coach-routed when the insight surface needs day-level grounding.",
  });

// v1.7.0 — unified dashboard first-paint snapshot. One GET that
// assembles every above-the-fold tile field in a single round-trip.
// Two-phase shape: `tiles` (fast, always present) + `extras` (thick,
// nullable on a rollup-coverage miss). The nested AI / DataSummary
// blocks are typed loosely (`z.record`) to match the comprehensive
// response style above — the strict shapes live in their own Zod
// modules and the iOS client does not consume this web-only route.
const dataSummaryRecord = z.record(z.string(), z.unknown());

const dashboardSnapshotResponse = z
  .object({
    user: z.object({
      username: z.string(),
      timezone: z.string(),
      heightCm: z.number().nullable(),
      dateOfBirth: z.string().nullable(),
      gender: z.enum(["MALE", "FEMALE"]).nullable(),
      glucoseUnit: z.string().nullable(),
      onboardingTourCompleted: z.boolean(),
      greetingHour: z.number().int(),
    }),
    layout: z.record(z.string(), z.unknown()),
    // v1.7.0 — full 27-id widget catalogue (16 server-known + 11
    // iOS-only) so a cold-launch first-paint seeds every tile and the
    // layout round-trips in one key. Additive alongside the web
    // `layout` block, which stays byte-identical.
    layoutCatalogue: z
      .array(
        z.object({
          id: z.string(),
          visible: z.boolean(),
          order: z.number().int(),
        }),
      )
      .describe(
        "Full 27-id widget catalogue (server-known + iOS-only) with per-widget visibility + order. iOS-only ids are appended default-invisible. The web dashboard reads `layout`; this block is the cold-launch seed for the native client.",
      ),
    // v1.7.0 — per-chartable-metric latest reading keyed by iOS
    // `MetricKind` raw value (e.g. `oxygenSaturation`,
    // `heartRateVariability`, `bodyMassIndex`). Derived in-process from
    // the slim summaries slice — no extra DB read.
    metricStates: z
      .record(
        z.string(),
        z.object({
          value: z.number(),
          measuredAt: z.string(),
          unit: z.string(),
        }),
      )
      .describe(
        "Latest reading per chartable metric, keyed by the iOS `MetricKind` raw value (the non-obvious raws: `oxygenSaturation`, `totalBodyWater`, `heartRateVariability`, `bodyMassIndex`, `walkingAsymmetryPercentage`, `walkingDoubleSupportPercentage`, `environmentalAudioExposure`, `headphoneAudioExposure`, `activeEnergyBurned`). Each entry carries `value`, `measuredAt` (ISO8601), and the canonical `unit`. Types the user has never logged are omitted.",
      ),
    tiles: z.object({
      summaries: dataSummaryRecord,
      lastSeenByType: z.record(z.string(), z.unknown()),
      mood: z.object({
        summary: dataSummaryRecord.nullable(),
        entries: z.array(
          z.object({
            date: z.string(),
            score: z.number(),
            samples: z.number().int(),
          }),
        ),
      }),
    }),
    extras: z
      .object({
        bpInTargetPct: z.number().nullable(),
        bpInTargetPct7d: z.number().nullable(),
        bpInTargetPct30d: z.number().nullable(),
        bpInTargetPctAllTime: z.number().nullable(),
        bpInTargetPctPriorMonth: z.number().nullable(),
        bpInTargetPctPriorYear: z.number().nullable(),
        glucoseByContext: dataSummaryRecord,
      })
      .nullable(),
    briefing: z.record(z.string(), z.unknown()).nullable(),
    briefingState: z.enum(["ready", "preparing", "disabled"]),
    briefingUpdatedAt: z.string().nullable(),
    generatedAt: z.string(),
  })
  .meta({
    id: "DashboardSnapshotResponse",
    description:
      "Unified above-the-fold dashboard payload. `tiles` always arrives (slim summaries + mood + resolved widget layout); `extras` (BD-in-target + per-context glucose) is null on a rollup-coverage miss so the strip never waits on the slowest read. `briefing` is lifted read-only from the pre-generated insight cache — never generated synchronously — and reports `ready` / `preparing` / `disabled` via `briefingState`. `layoutCatalogue` (full 27-id widget catalogue) and `metricStates` (latest reading per metric, keyed by iOS `MetricKind` raw value) are additive cold-launch seeds for the native client; both derive in-process from data already fetched, adding no DB round-trip.",
  });

// v1.5.0 — natural-language medication extraction route. The wizard's
// optional "Beschreiben" overlay POSTs a free-text description and
// receives a partial structured payload the form merges onto whatever
// the user already typed. Citation-guarded (`name` and `dose` are
// dropped when not substring-matched in the original text) and
// closed-enum-validated.
const medicationExtractRequest = z
  .object({
    text: z
      .string()
      .min(1)
      .max(2000)
      .describe(
        "Free-text medication description (any locale). Up to 2 000 characters. The model never echoes the text back into another tenant — it is only used to produce the structured fields.",
      ),
    locale: z
      .enum(["en", "de", "es", "fr", "it", "pl"])
      .optional()
      .describe("Optional UI locale hint for the model."),
    today: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        "Optional override of the reference date used to resolve relative phrases (\"tomorrow\", \"next Monday\"). Format: `YYYY-MM-DD`. Defaults to the server's UTC day.",
      ),
  })
  .meta({
    id: "MedicationExtractRequest",
    description:
      "Free-text medication description payload. The route runs the text through the Coach provider chain and returns a partial structured payload the wizard merges. Rate-limited 10 requests / 5 minutes / user; budget-gated against the daily Coach token ceiling.",
  });

medicationExtractionSchema.meta({
  id: "MedicationExtractionResult",
  description:
    "Citation-guarded partial extraction of medication scheduling fields. Every field is optional; the wizard merges what is present onto the form state and leaves the rest blank. `name` and `dose` are post-validated against the original free-text and dropped when not substring-matched, so the wizard cannot silently land a hallucinated brand or dose. `cadenceKind` / `doseUnit` / `weekdays` are closed enums; numeric fields are clamped to the wizard's wire bounds.",
});

// Insights tile layout — mirrors the Zod schema in
// `src/app/api/insights/layout/route.ts`. The tile-id enum is derived
// from the same `ACCEPTED_INSIGHTS_TILE_IDS` source so the contract
// cannot drift.
//
// v1.8.0 — the canonical ids are English (`blood-pressure`, `pulse`,
// `oxygen`, `body-temperature`, `weight`, `active-energy`, `sleep`,
// `resting-pulse`, `mood`, `medications`). The endpoint still ACCEPTS
// the legacy German ids (`blutdruck`, `puls`, `sauerstoff`,
// `koerpertemperatur`, `gewicht`, `aktive-energie`, `schlaf`,
// `ruhepuls`, `stimmung`, `medikamente`) on input so existing iOS
// layouts keep validating; the server normalises them to the canonical
// English id before persisting, and GET always returns canonical ids.
// The legacy ids are accepted-but-deprecated and will be dropped from
// the accepted set in a future major.
const insightsLayoutSchema = z
  .object({
    version: z.literal(1),
    tiles: z
      .array(
        z.object({
          id: z.enum(ACCEPTED_INSIGHTS_TILE_IDS),
          visible: z.boolean(),
          order: z.number().int().min(0).max(99),
        }),
      )
      .min(1)
      .max(50),
  })
  .meta({
    id: "InsightsLayoutBody",
    description:
      "Per-user Insights tile layout: an ordered list of tiles with a visibility flag. `version` is the layout schema version. Tile ids are a closed enum: the canonical ids are English (matching the routed `/insights/<slug>` sub-pages). The legacy German ids (blutdruck, puls, sauerstoff, koerpertemperatur, gewicht, aktive-energie, schlaf, ruhepuls, stimmung, medikamente) remain accepted on input for backward compatibility and are normalised to their English equivalents before persisting; GET responses always carry the canonical English ids. The legacy ids are deprecated and will be removed in a future major version.",
  });

// v1.7.0 — health-record export selection. Strict shape: unknown keys
// (including any attempt to smuggle a userId) 422 via returnAllZodIssues.
exportSelectionSchema.meta({
  id: "HealthRecordExportRequest",
  description:
    "v1.7.0 — health-record / doctor-handover export selection. `format` picks PDF, FHIR R4 document Bundle, or a combined zip package. Grouped `sections` toggles drive which domains are read (mood is opt-in, off by default). No `userId` field — the user is always narrowed from the session/Bearer. The route is strict: unknown keys 422.",
});

// ── Standard 401 / 422 / 429 responses ───────────────────────────────

const stdResponses = {
  "401": {
    description: "Authentication required or invalid credentials.",
    content: { "application/json": { schema: errorEnvelope } },
  },
  "422": {
    description: "Request validation failed.",
    content: { "application/json": { schema: errorEnvelope } },
  },
  "429": {
    description: "Rate limit exceeded.",
    content: { "application/json": { schema: errorEnvelope } },
  },
};

// ── Path table ───────────────────────────────────────────────────────

export const openApiPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/export/health-record": {
    post: {
      tags: ["Export"],
      summary: "Generate a health-record export (PDF / FHIR / package)",
      description:
        "v1.7.0 flagship export. Returns the doctor-handover artefact in the requested `format`: `pdf` → application/pdf, `fhir` → application/fhir+json (HL7 FHIR R4 document Bundle), `package` → application/zip (PDF + FHIR + README). Auth via cookie or Bearer; shared `export:<userId>` rate bucket (10/h). Strict validation: unknown keys 422.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: exportSelectionSchema },
        },
      },
      responses: {
        "200": {
          description:
            "Export generated. Content-Type varies by `format`: application/pdf, application/fhir+json, or application/zip.",
          content: {
            "application/pdf": {
              schema: z.string().meta({ format: "binary" }),
            },
            "application/fhir+json": {
              schema: z.string().meta({ format: "binary" }),
            },
            "application/zip": {
              schema: z.string().meta({ format: "binary" }),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/login": {
    post: {
      tags: ["Auth"],
      summary: "Email-or-username login (password)",
      description:
        "Browser callers receive a session cookie. Native callers (X-Client-Type: native or HealthLog-iOS UA prefix) additionally receive a paired access + refresh token.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: loginPasswordSchema } },
      },
      responses: {
        "200": {
          description: "Login succeeded.",
          content: {
            "application/json": {
              schema: dataEnvelope(accessRefreshBundle, "LoginResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/passkey/login-verify": {
    post: {
      tags: ["Auth"],
      summary: "Passkey assertion verification",
      requestBody: {
        required: true,
        content: { "application/json": { schema: passkeyLoginVerifyRequest } },
      },
      responses: {
        "200": {
          description: "Assertion verified — session + optional bearer issued.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                accessRefreshBundle,
                "PasskeyLoginVerifyResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/refresh": {
    post: {
      tags: ["Auth"],
      summary: "Rotate refresh token (one-time use)",
      description:
        "Reuse of a consumed refresh token revokes every refresh token still active for the originating device (per-device blast radius from v1.4.23). Legacy tokens issued before v1.4.23 with a null deviceId fall back to revoke-all-for-user.\n\n" +
        "On a 401, `meta.errorCode` is a stable machine code so the client can branch terminal re-auth from a transient blip without parsing the prose `error`: `auth.refresh.reuse` (a consumed token was replayed — device family revoked, re-pair required), `auth.refresh.revoked` (family revoked out-of-band — re-pair required), `auth.refresh.invalid` (not found / expired — drop the token and re-authenticate).",
      requestBody: {
        required: true,
        content: { "application/json": { schema: refreshRequest } },
      },
      responses: {
        "200": {
          description: "Rotation succeeded — new pair issued.",
          content: {
            "application/json": {
              schema: dataEnvelope(accessRefreshBundle, "RefreshResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/sync/state": {
    get: {
      tags: ["Sync"],
      summary: "Sync handshake + window metadata",
      description:
        "Cheap 'should I sync?' summary. Returns the previous `lastSyncedAt` checkpoint and advances it server-side on each call. The `sync` block carries the incremental-delta window + tombstone retention so the client reads them rather than hardcoding.",
      responses: {
        "200": {
          description: "Sync state summary.",
          content: {
            "application/json": {
              schema: dataEnvelope(syncStateResponse, "SyncStateEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/sync/changes": {
    get: {
      tags: ["Sync"],
      summary: "Measurements delta feed",
      description:
        "Incremental catch-up after the first-pair backfill (never a replacement for it). Pages over an opaque keyset cursor; each page carries `tombstones` (soft-deleted rows, keyed on `externalId`) and `upserts` (live rows). Apply tombstones before upserts within a page. `cursorExpired: true` forces a clean re-init.",
      requestParams: {
        query: syncChangesQuery,
      },
      responses: {
        "200": {
          description: "Delta page.",
          content: {
            "application/json": {
              schema: dataEnvelope(syncChangesResponse, "SyncChangesEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/measurements": {
    get: {
      tags: ["Measurements"],
      summary: "List measurements",
      description:
        "Filter by type + date range. Response is paged via offset/limit; default limit 100, hard cap 500.",
      requestParams: {
        query: listMeasurementsSchema,
      },
      responses: {
        "200": {
          description: "Measurement page.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  measurements: z.array(measurementResource),
                  total: z.number().int().nonnegative(),
                }),
                "ListMeasurementsResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    post: {
      tags: ["Measurements"],
      summary: "Create one measurement",
      description:
        "Single ingest. Use `/api/measurements/batch` for Apple Health upload streams.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: createMeasurementSchema } },
      },
      responses: {
        "201": {
          description: "Created.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                measurementResource,
                "CreateMeasurementResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/measurements/batch": {
    post: {
      tags: ["Measurements"],
      summary: "Apple Health batch ingest",
      description:
        "Up to 500 HealthKit entries per call. Idempotent via the `Idempotency-Key` header (replay window 24h). Per-entry status lets the iOS client advance its sync cursor accurately. v1.4.25 W8c adds an optional `deviceType` per entry — feed it from `HKDevice.model` so the cross-source canonical picker can break Apple-Watch-vs-iPhone ties; null/absent stays backward-compatible with v1.4.23 clients.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: batchPayloadSchema } },
      },
      responses: {
        "200": {
          description: "Batch processed.",
          content: {
            "application/json": {
              schema: dataEnvelope(batchResponse, "BatchMeasurementsResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/measurements/by-external-ids": {
    delete: {
      tags: ["Measurements"],
      summary: "Delete measurements by external ID (iOS deletion-sync)",
      description:
        "Removes the user's measurement rows whose externalId is in the request list. Rows owned by another user are silently skipped (cross-user 404 guard). Up to 500 externalIds per call.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: deleteByExternalIdsRequest },
        },
      },
      responses: {
        "200": {
          description: "Delete batch processed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                deleteByExternalIdsResponse,
                "MeasurementsDeleteByExternalIdsResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
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
        ...stdResponses,
      },
    },
  },
  "/api/workouts/{id}": {
    get: {
      tags: ["Measurements"],
      summary: "Workout detail (v1.4.32)",
      description:
        "Single-workout envelope. Owns the optional `WorkoutRoute` GeoJSON geometry + `canonicalId` pointer that resolves to the cluster winner so deep-links into non-canonical twin rows can redirect cleanly. Cross-user rows surface as 404 (existence channel sealed).",
      requestParams: {
        path: z.object({ id: z.string() }),
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
        ...stdResponses,
      },
    },
  },
  "/api/workouts/batch": {
    post: {
      tags: ["Measurements"],
      summary: "Typed workout batch ingest (v1.4.25 W16b)",
      description:
        "Server-side ingest endpoint for HKWorkout records (iOS) and Withings activity rows (server-to-server). Up to 100 workouts per call; nested route geometry (GeoJSON LineString) is capped at 20 000 points and stored in a 1:1 `WorkoutRoute` row keyed by `workoutId`. Idempotent via the `Idempotency-Key` header (replay window 24h). Per-entry status (`inserted | duplicate | skipped`) lets the iOS sync cursor checkpoint accurately. The request body ceiling is 5 MB enforced at the HTTP layer — clients above the ceiling receive a 413 with `workout.batch.payload_too_large`.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: createBatchWorkoutSchema } },
      },
      responses: {
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
      },
    },
  },
  "/api/devices": {
    post: {
      tags: ["Devices"],
      summary: "Register native device + APNs token",
      description:
        "Idempotent upsert by `token`. APNs token + environment are paired — supplying one without the other returns 422. Cross-user re-registration of either identifier returns 409.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: deviceRegisterRequest } },
      },
      responses: {
        "201": {
          description: "Device registered or refreshed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ id: z.string() }),
                "DeviceRegisterResponse",
              ),
            },
          },
        },
        "409": {
          description:
            "Device or APNs token already registered to another user.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications": {
    get: {
      tags: ["Medications"],
      summary: "List medications for the calling user",
      description:
        "Returns every medication owned by the caller (active + paused), ordered by `createdAt DESC`. Each row carries its nested `schedules`, the joined clinical `category`, the latest non-skipped `lastTakenAt`, and the count of intake events scheduled for today (`todayEventCount`). The response is cached server-side for 60 s per user; writes flush the cache.",
      responses: {
        "200": {
          description: "Medication list.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.array(medicationListEntry),
                "ListMedicationsResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    post: {
      tags: ["Medications"],
      summary: "Create a medication with at least one schedule",
      description:
        "Validates the body against `CreateMedicationRequest`, applies the v1.5 cross-field invariants (one-shot consistency, recurring default `FREQ=DAILY`, `timesOfDay` dual-write), and creates the medication + its schedules in a single Prisma write. Audits as `medication.create`.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: createMedicationSchema } },
      },
      responses: {
        "201": {
          description: "Created medication with its schedules.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationDetailEntry,
                "CreateMedicationResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/{id}": {
    get: {
      tags: ["Medications"],
      summary: "Fetch a single medication",
      description:
        "Returns the medication + its schedules + the joined `category`. Cross-user rows surface as 404 (existence channel sealed).",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        "200": {
          description: "Medication detail.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationDetailEntry,
                "GetMedicationResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Medications"],
      summary: "Replace a medication (partial fields)",
      description:
        "Every field on the body is optional; omitted fields are left untouched. Supplying `schedules` REPLACES the medication's full schedule list (the route deletes existing rows before re-creating). Flipping `active` to false stamps `pausedAt`; flipping back to true clears it. v1.5 invariants on the `schedules` array match `POST /api/medications`. Audits as `medication.update`.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      requestBody: {
        required: true,
        content: { "application/json": { schema: updateMedicationSchema } },
      },
      responses: {
        "200": {
          description: "Updated medication.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationDetailEntry,
                "UpdateMedicationResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Medications"],
      summary: "Delete a medication",
      description:
        "Cascades to the medication's schedules, intake events, dose changes, inventory rows, and side-effect logs. Revokes every API token scoped to `medication:<id>:ingest`. Audits as `medication.delete`.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        "200": {
          description: "Deletion succeeded.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ deleted: z.boolean() }),
                "DeleteMedicationResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/{id}/intake": {
    post: {
      tags: ["Medications"],
      summary: "Log an intake event for a medication",
      description:
        "Records a taken or skipped dose. Idempotent via the `Idempotency-Key` header AND the optional `idempotencyKey` body field (the route walks both paths); a re-post inside the 60 s server-side dedup window returns the original event. Non-skipped intakes auto-decrement pen inventory (best-effort), refresh the per-day compliance rollup, and — for `oneShot:true` medications — flip `active` to false.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      requestBody: {
        required: true,
        content: { "application/json": { schema: intakeSchema } },
      },
      responses: {
        "201": {
          description: "Intake event created.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationIntakeEventResource,
                "CreateMedicationIntakeResponse",
              ),
            },
          },
        },
        "200": {
          description:
            "Idempotent replay — the original event is returned without creating a new row.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationIntakeEventResource,
                "ReplayMedicationIntakeResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/extract": {
    post: {
      tags: ["Medications"],
      summary: "Extract scheduling fields from a free-text medication description",
      description:
        "Runs the user's free-text description through the Coach provider chain and returns a citation-guarded partial payload the wizard merges onto whatever the user already typed. `name` and `dose` are dropped when not substring-matched in the original text so the wizard cannot land a hallucinated brand or dose. `cadenceKind` / `doseUnit` / `weekdays` are closed enums; numeric fields are clamped. Rate-limited 10 requests / 5 minutes / user, gated against the daily Coach token budget.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: medicationExtractRequest },
        },
      },
      responses: {
        "200": {
          description: "Citation-guarded partial extraction.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationExtractionSchema,
                "MedicationExtractResponse",
              ),
            },
          },
        },
        "502": {
          description:
            "Upstream provider returned an empty, unparseable, or off-schema reply.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "503": {
          description:
            "No AI provider configured for the calling user (or operator).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/{id}/cadence": {
    get: {
      tags: ["Medications"],
      summary: "Cadence + compliance read for a medication",
      description:
        "Returns the expected-vs-actual dose timeline for the requested window plus the four compliance chip values that drive the detail-page section. Pure computation — no writes. Day boundaries are resolved in the user's IANA timezone so a Tokyo user and a Berlin user see the same chips for the same medication. The `days` query parameter caps at 180.",
      requestParams: {
        path: z.object({ id: z.string() }),
        query: z.object({
          days: z
            .coerce
            .number()
            .int()
            .min(1)
            .max(180)
            .optional()
            .describe("Window size in days (default 30, max 180)."),
        }),
      },
      responses: {
        "200": {
          description: "Cadence response.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationCadenceResponse,
                "GetMedicationCadenceResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/coach-prefs": {
    get: {
      tags: ["Auth"],
      summary: "Read per-user Coach prompt-tuning preferences",
      description:
        "Returns the persisted preferences with defaults filled in. Null persisted state resolves to the legacy v1.4.22 defaults.",
      responses: {
        "200": {
          description: "Resolved preferences.",
          content: {
            "application/json": {
              schema: dataEnvelope(coachPrefsSchema, "GetCoachPrefsResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Auth"],
      summary: "Replace per-user Coach prompt-tuning preferences",
      description:
        "Persists the supplied prefs. Body is validated against `CoachPrefs`; missing keys fall back to the documented defaults.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: coachPrefsSchema } },
      },
      responses: {
        "200": {
          description: "Saved preferences echoed back.",
          content: {
            "application/json": {
              schema: dataEnvelope(coachPrefsSchema, "PutCoachPrefsResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/disable-coach": {
    get: {
      tags: ["Auth"],
      summary: "Read per-user Coach opt-out flag",
      description:
        "Returns the user's per-account Coach opt-out flag. Default `false` (Coach visible). Powers the Settings → Insights \"Hide Coach\" Switch and the layout FAB short-circuit.",
      responses: {
        "200": {
          description: "Resolved flag.",
          content: {
            "application/json": {
              schema: dataEnvelope(disableCoachFlag, "GetDisableCoachResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Auth"],
      summary: "Toggle per-user Coach opt-out flag",
      description:
        "Flips the per-account Coach opt-out flag. Idempotent — the DB write fires even when the value matches so the audit-log row mirrors the API call. Rate-limit 60/min per user.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: disableCoachFlag } },
      },
      responses: {
        "200": {
          description:
            "Resolved next-state echoed back for optimistic-update consumers.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                disableCoachFlag,
                "PatchDisableCoachResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/source-priority": {
    get: {
      tags: ["Auth"],
      summary: "Read per-user source priority",
      description:
        "Returns the per-metric-class source priority used by the analytics aggregator. Missing keys fall back to `DEFAULT_SOURCE_PRIORITY`. Null persisted state resolves to the documented defaults.",
      responses: {
        "200": {
          description: "Resolved priority.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                sourcePrioritySchema,
                "GetSourcePriorityResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Auth"],
      summary: "Replace per-user source priority",
      description:
        "Persists the supplied priority. Body is validated against `SourcePriority`; missing keys read as `DEFAULT_SOURCE_PRIORITY` at the call site.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: sourcePrioritySchema } },
      },
      responses: {
        "200": {
          description: "Saved priority (defaulted) echoed back.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                sourcePrioritySchema,
                "PutSourcePriorityResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/user/avatar": {
    post: {
      tags: ["Auth"],
      summary: "Upload the calling user's avatar",
      description:
        "Multipart upload (field `file`). Accepts image/jpeg, image/png, image/webp; rejects anything else at the magic-byte sniff (the multipart Content-Type header is informational only). Hard caps: 2 MiB body, 2048×2048 dimensions. Replaces the v1.4.22 Gravatar leak by storing the bytes on the User row + serving them from same-origin.",
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: z.object({
              file: z
                .string()
                .describe(
                  "Binary image payload (JPEG / PNG / WebP). Hard-capped at 2 MiB and 2048×2048.",
                ),
            }),
          },
        },
      },
      responses: {
        "201": {
          description:
            "Avatar saved. `avatarUrl` is the same value the /me payload returns; the `?v=` suffix busts client caches on re-upload.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  avatarUrl: z.string(),
                  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
                  updatedAt: z.iso.datetime({ offset: true }),
                }),
                "UploadAvatarResponse",
              ),
            },
          },
        },
        "413": {
          description:
            "Upload exceeds the 2 MiB byte limit or the 2048×2048 dimension limit.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "415": {
          description:
            "Image format is not one of JPEG / PNG / WebP (magic-byte sniff).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Auth"],
      summary: "Clear the calling user's avatar",
      description:
        "Resets the avatar columns to null. Idempotent — a delete on an already-empty row returns 204 with no audit-log row.",
      responses: {
        "204": {
          description: "Avatar cleared (or already empty).",
        },
        ...stdResponses,
      },
    },
  },
  "/api/user/avatar/{id}": {
    get: {
      tags: ["Auth"],
      summary: "Serve a user's avatar bytes",
      description:
        "Owner-scoped. The `{id}` path segment must match the calling user's id — cross-user reads return 403. Response body is the raw image bytes with the persisted `Content-Type`; the /me payload appends `?v={updatedAtMs}` so clients can cache aggressively.",
      requestParams: {
        path: z.object({
          id: z.string().describe("User id (must match the calling user)."),
        }),
      },
      responses: {
        "200": {
          description: "Avatar bytes.",
          content: {
            "image/jpeg": { schema: z.string().describe("Raw JPEG bytes.") },
            "image/png": { schema: z.string().describe("Raw PNG bytes.") },
            "image/webp": { schema: z.string().describe("Raw WebP bytes.") },
          },
        },
        "403": {
          description: "Caller is not the avatar's owner.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "404": {
          description: "The user has no uploaded avatar.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/layout": {
    get: {
      tags: ["Insights"],
      summary: "Read the calling user's Insights tile layout",
      description:
        "Returns the per-user Insights tile layout (visibility + order). Falls back to the default layout when the user has not customised it. Mirrors the dashboard-widgets contract.",
      responses: {
        "200": {
          description: "The resolved layout (custom or default).",
          content: {
            "application/json": {
              schema: dataEnvelope(insightsLayoutSchema, "InsightsLayout"),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Insights"],
      summary: "Replace the calling user's Insights tile layout",
      description:
        "Persists the full tile layout. The normalised layout is returned. Invalid bodies return the multi-issue 422 envelope, matching the dashboard-widgets route.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: insightsLayoutSchema },
        },
      },
      responses: {
        "200": {
          description: "Layout saved; the normalised layout is echoed back.",
          content: {
            "application/json": {
              schema: dataEnvelope(insightsLayoutSchema, "InsightsLayoutSaved"),
            },
          },
        },
        // 422 (multi-issue validation envelope) comes from stdResponses.
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Insights"],
      summary: "Reset the calling user's Insights tile layout",
      description:
        "Clears the persisted layout and returns the default layout. Idempotent.",
      responses: {
        "200": {
          description: "Layout reset; the default layout is returned.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                insightsLayoutSchema,
                "InsightsLayoutReset",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/chat/messages/{id}/feedback": {
    post: {
      tags: ["Insights"],
      summary: "Rate a Coach assistant message",
      description:
        "Persists a helpful/unhelpful rating for a single Coach reply. Reuses the v1.4.16 RecommendationFeedback table via the polymorphic `targetType` column. The aggregator buckets ratings by (promptVersion, tone, verbosity).",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: coachMessageFeedbackBody },
        },
      },
      responses: {
        "201": {
          description: "Feedback saved.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  id: z.string(),
                  createdAt: z.iso.datetime({ offset: true }),
                }),
                "CoachMessageFeedbackResponse",
              ),
            },
          },
        },
        "404": {
          description: "Message not found or not owned by the caller.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description: "Caller has already rated this message text.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/admin/notifications/diagnostic": {
    get: {
      tags: ["Admin"],
      summary: "Admin notification diagnostic snapshot",
      description:
        "Admin-only. Returns what the dispatcher would see when targeting the calling admin's account: registered devices (APNs tokens masked to prefix + suffix), per-channel enabled + configPresent flags, and recent push attempts (currently always `[]` pending the v1.4.48+ PushAttempt table). Cookie auth only — never Bearer.",
      responses: {
        "200": {
          description: "Diagnostic snapshot.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                adminDiagnosticData,
                "AdminDiagnosticResponse",
              ),
            },
          },
        },
        "403": {
          description: "Caller is not an admin.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/dashboard/snapshot": {
    get: {
      tags: ["Dashboard"],
      summary: "Unified dashboard first-paint snapshot",
      description:
        "Assembles every above-the-fold tile field in one round-trip from the rollup / mood / widget helpers plus a read-only lift of the pre-generated daily briefing. Two-phase: `tiles` always present, `extras` nullable on a rollup-coverage miss. No LLM is reachable from this path. Cookie or Bearer auth.",
      responses: {
        "200": {
          description: "Dashboard snapshot.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                dashboardSnapshotResponse,
                "DashboardSnapshotResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/comprehensive": {
    get: {
      tags: ["Insights"],
      summary: "Comprehensive AI insights bundle",
      description:
        "Full Insights surface — daily briefing, recommendations with rationale, optional weekly report + storyboard annotations. Strict-schema validated server-side.",
      responses: {
        "200": {
          description: "Insights bundle.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                insightsComprehensiveResponse,
                "InsightsComprehensiveResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};

export const openApiComponents: NonNullable<ZodOpenApiObject["components"]> = {
  // Schemas listed here are forced into `components.schemas` even when no
  // route references them directly. `Medication` lives in this slot
  // because its only consumers are the `MedicationListEntry` /
  // `MedicationDetail` variants which extend it — `.extend()` inlines
  // the base shape into the derived schema, so without an explicit
  // registration the standalone `Medication` component would never
  // emit. The iOS codegen reads from `Medication` directly for the
  // shared Swift struct backing both variants.
  schemas: {
    Medication: medicationResource,
  },
  securitySchemes: {
    bearerAuth: {
      type: "http",
      scheme: "bearer",
      bearerFormat: "hlk_<64hex>",
      description:
        "Native-client API token. Use the `token` field returned by /api/auth/login on a native client.",
    },
    cookieAuth: {
      type: "apiKey",
      in: "cookie",
      name: "healthlog_session",
      description: "Browser session cookie — set by /api/auth/login.",
    },
  },
};
