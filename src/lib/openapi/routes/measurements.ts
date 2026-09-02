/**
 * OpenAPI route table — measurements, batch ingest, bulk delete, sleep night.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Schemas come from `src/lib/validations/*` where shared with the
 * runtime request parsing, so the wire contract stays single-source.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
import { updateMeasurementSchema } from "@/lib/validations/measurement";
import { seriesBatchQuerySchema } from "@/lib/validations/series-batch";
import { deviceTypeEnum } from "@/lib/validations/source-priority";
import {
  MODULE_DISABLED_DESCRIPTION,
  createMeasurementSchema,
  dataEnvelope,
  errorEnvelope,
  idempotencyKeyParameter,
  idempotentWrite,
  listMeasurementsSchema,
  measurementSourceEnum,
  measurementTypeEnum,
  recordRefusal,
  stdResponses,
} from "./shared";

const batchEntrySchema = z
  .object({
    hkIdentifier: z
      .string()
      .min(1)
      .max(120)
      .describe(
        "HealthKit identifier (e.g. `HKQuantityTypeIdentifierBodyMass`).",
      ),
    value: z
      .number()
      .finite()
      .describe(
        "Raw HealthKit reading in Apple's native unit; the server applies any canonical scaling at ingest. For a 10-minute heart-rate bucket (see `externalId`) this is the bucket's AVERAGE bpm; the bucket's spread rides `valueMin` / `valueMax`.",
      ),
    valueMin: z
      .number()
      .finite()
      .optional()
      .describe(
        "v1.19.2 (iOS #34 extension) — the bucket's MINIMUM bpm for a 10-minute heart-rate bucket (see `externalId`). Persisted ONLY on a well-formed `stats:HKQuantityTypeIdentifierHeartRate:<bucket-start>` row; ignored (stored null) on every other entry. Omit on a pre-v1.19.2 client — the bucket keeps the avg-only contract.",
      ),
    valueMax: z
      .number()
      .finite()
      .optional()
      .describe(
        "v1.19.2 (iOS #34 extension) — the bucket's MAXIMUM bpm for a 10-minute heart-rate bucket (see `externalId`). Persisted ONLY on a well-formed `stats:HKQuantityTypeIdentifierHeartRate:<bucket-start>` row; ignored (stored null) on every other entry. Omit on a pre-v1.19.2 client — the bucket keeps the avg-only contract.",
      ),
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
    categoryValue: z
      .number()
      .int()
      .min(0)
      .max(20)
      .optional()
      .describe(
        "v1.10.0 — `HKCategoryValue` codepoint for an EVENT-class category sample (irregular-rhythm, high/low-HR, walking-steadiness, breathing-disturbance). Carries the device's own classification verdict / severity, which the server resolves to a stored `rhythmClassification`. HealthLog stores ONLY the device's result — it never re-classifies. Ignored for non-event identifiers.",
      ),
    externalId: z
      .string()
      .min(1)
      .max(120)
      .describe(
        "Dedup key for the `(userId, type, source, externalId)` composite index. Three shapes:\n" +
          "• `HKSample.uuid` — a per-sample reading. First-write-wins: a re-post returns `duplicate` and the stored row is immutable.\n" +
          "• `stats:<HKQuantityTypeIdentifier>:<YYYY-MM-DD>` — a per-day cumulative total (Steps, Active Energy, Sleep Duration, Walking/Running Distance, Flights Climbed). A re-post OVERWRITES the row and returns `updated`.\n" +
          "• `stats:HKQuantityTypeIdentifierHeartRate:<bucket-start>` — v1.19.0 (iOS #34), refined to 10-minute granularity in v1.30.7, heart-rate bucket carrying the bucket's AVERAGE bpm as one PULSE row. `<bucket-start>` is the ISO-8601 UTC 10-minute boundary — zeroed seconds/millis, minutes ∈ {00,10,20,30,40,50}, trailing `Z` (e.g. `2026-06-21T14:10:00.000Z`). A re-post OVERWRITES the row and returns `updated`, so iOS uploads ~144 rows/day instead of one per raw HR sample. A row that targets this prefix with a malformed bucket-start suffix is `skipped` with reason `malformed_hr_bucket_id`.\n" +
          "The id MUST be stable across app restarts. An object description or memory address (`<Class: 0x…>`, `0x12ab34cd`) is a new value on every launch, so it can never match its own earlier row; such an entry is `skipped` with reason `unstable_external_id` while the rest of the batch still lands.",
      ),
    externalSourceVersion: z.string().min(1).max(120).optional(),
    // v1.8.6 W6 — optional per-entry source tag. Defaults to
    // `APPLE_HEALTH` server-side when omitted, so legacy clients are
    // unchanged. Restricted to the `{APPLE_HEALTH, MANUAL}` subset of
    // `MeasurementSource`: `WITHINGS` / `IMPORT` are server-owned and
    // rejected on this client-facing route.
    source: z
      .enum(["APPLE_HEALTH", "MANUAL"])
      .optional()
      .describe(
        "Source attribution for the row. Defaults to `APPLE_HEALTH` when omitted. Send `MANUAL` to tag rows the user entered by hand on-device (e.g. the standalone adopt-on-pair backfill). Part of the `(userId, type, source, externalId)` dedup key, so the same externalId under a different source is a distinct row. `WITHINGS` / `IMPORT` are not accepted here.",
      ),
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
    // v1.32.8 (iOS #66) — optional per-request diagnostic tag naming what woke
    // the client for this sync. Diagnostic only: it is recorded on the ingest
    // wide event and on the account's HealthKit diagnostic fields, which
    // `GET /api/integrations/healthkit` publishes. It is never deduped on or
    // used in attribution — sending it or omitting it produces byte-identical
    // row outcomes. Omit on any client that does not track its wake reason.
    syncTrigger: z
      .enum(["foreground", "background", "push"])
      .optional()
      .describe(
        "Diagnostic-only. Names what triggered this sync (foreground app open, background refresh, or a push wake). Recorded on the ingest wide event and kept on the account as `lastSyncTrigger` — plus `lastBackgroundSyncAt` for a `background` or `push` trigger — both readable from `GET /api/integrations/healthkit`. It does not affect dedup, attribution, or how any sample is stored. Optional and backward-compatible: pre-#66 clients omit it.",
      ),
  })
  .meta({
    id: "AppleHealthBatchRequest",
    description:
      "Apple Health batch ingest. ≤500 entries per call; idempotent via `Idempotency-Key`.",
  });

const batchEntryResult = z
  .object({
    index: z.number().int().nonnegative(),
    status: z
      .enum(["inserted", "updated", "duplicate", "skipped", "failed"])
      .describe(
        "`inserted`/`duplicate` — the row landed (advance the cursor). `updated` — a `stats:` aggregate overwrote an existing row. `skipped` — validation no-op; see `reason`. `failed` — retryable database failure that must not advance the entry cursor; the response is marked `Cache-Control: no-store`.",
      ),
    reason: z.string().optional(),
  })
  .meta({ id: "AppleHealthBatchEntryResult" });

const batchResponse = z
  .object({
    processed: z.number().int().nonnegative(),
    inserted: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.array(
      z.object({
        index: z.number().int().nonnegative(),
        reason: z.string(),
      }),
    ),
    entries: z.array(batchEntryResult),
  })
  .meta({ id: "AppleHealthBatchResponse" });

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

// v1.15.13 — multi-select bulk soft-delete for the measurements
// management list. Ids are scoped to the caller; forged / foreign ids
// are silent no-ops (no existence leak). Soft-delete (tombstone), so the
// rows surface in the `/api/sync/changes` delta feed.
const bulkDeleteMeasurementsRequest = z
  .object({
    ids: z.array(z.string().min(1)).min(1).max(200),
  })
  .meta({
    id: "MeasurementsBulkDeleteRequest",
    description:
      "1..200 measurement ids, scoped to the caller. Forged / foreign ids are silently skipped (no existence leak).",
  });

const bulkDeleteMeasurementsResponse = z
  .object({
    deleted: z.number().int().nonnegative(),
  })
  .meta({ id: "MeasurementsBulkDeleteResult" });

// v1.16.4 — un-tombstone for the management list's delete-Undo
// affordance. Same id-scoping rules as the bulk delete: forged /
// foreign / not-deleted ids are silent no-ops.
const restoreMeasurementsRequest = z
  .object({
    ids: z.array(z.string().min(1)).min(1).max(200),
  })
  .meta({
    id: "MeasurementsRestoreRequest",
    description:
      "1..200 measurement ids, scoped to the caller. Forged / foreign / not-deleted ids are silently skipped (no existence leak).",
  });

const restoreMeasurementsResponse = z
  .object({
    restored: z.number().int().nonnegative(),
  })
  .meta({ id: "MeasurementsRestoreResult" });

export const measurementResource = z
  .object({
    id: z
      .string()
      .describe(
        "Stored row id, or a synthetic key (`day:<type>:<dayKey>`, `sleep-seg:<dayKey>:<n>`) on the collapsed list modes.",
      ),
    type: measurementTypeEnum,
    value: z.number(),
    unit: z.string(),
    measuredAt: z.iso.datetime({ offset: true }),
    source: measurementSourceEnum,
    notes: z.string().nullable().optional(),
    // The list / detail reads hand back the whole stored row minus the
    // `notesEncrypted` ciphertext, so every remaining scalar column is on the
    // wire. Optional rather than required because the collapsed list modes
    // (day-sum, sleep-segment) synthesise rows that carry only the display
    // fields above.
    userId: z.string().optional(),
    valueMin: z
      .number()
      .nullable()
      .optional()
      .describe(
        "Bucket MINIMUM — set only on an hourly heart-rate `stats:` row.",
      ),
    valueMax: z
      .number()
      .nullable()
      .optional()
      .describe(
        "Bucket MAXIMUM — set only on an hourly heart-rate `stats:` row.",
      ),
    externalId: z
      .string()
      .nullable()
      .optional()
      .describe("External-system dedup key; null for manual entries."),
    externalSourceVersion: z.string().nullable().optional(),
    glucoseContext: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Set only on BLOOD_GLUCOSE rows, and null there too when the writer recorded no classification (a sensor export, a device sync). Never invent one.",
      ),
    sleepStage: z
      .string()
      .nullable()
      .optional()
      .describe("Set only on SLEEP_DURATION rows."),
    rhythmClassification: z
      .string()
      .nullable()
      .optional()
      .describe("Device classification verdict; set only on EVENT rows."),
    deviceType: z
      .string()
      .nullable()
      .optional()
      .describe("`watch | band | ring | phone | scale | other | unknown`."),
    syncVersion: z
      .number()
      .int()
      .optional()
      .describe(
        "Bumped on every server-side mutation; the last-writer-wins input for cross-device reconciliation.",
      ),
    deletedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .optional()
      .describe("Soft-delete tombstone; null on a live row."),
    createdAt: z.iso.datetime({ offset: true }).optional(),
    updatedAt: z.iso.datetime({ offset: true }).optional(),
    // Synthesised-row extras — present only on the collapsed day-sum mode.
    dayKey: z.string().optional(),
    sampleCount: z.number().int().optional(),
    partial: z
      .boolean()
      .optional()
      .describe(
        "True on the one bucket whose day was cut off by the read cap, so its sum understates the real total.",
      ),
  })
  .meta({
    id: "MeasurementResource",
    description:
      "Server-shaped measurement row. GET endpoints return the whole stored row with the decrypted note on `notes` and the `notesEncrypted` ciphertext stripped; the collapsed list modes synthesise rows carrying the display fields plus `dayKey` / `sampleCount`.",
  });

/**
 * The aggregate list modes (`aggregate=daily` and the coarser grains) return
 * pre-folded buckets, not stored rows — no `id`, `unit` or `source`.
 */
const aggregatedMeasurementBucket = z
  .object({
    type: measurementTypeEnum,
    value: z.number().describe("The bucket's aggregated value."),
    measuredAt: z.iso.datetime({ offset: true }).describe("Bucket start."),
    count: z.number().int().nonnegative().optional(),
    unit: z.string().optional(),
  })
  .meta({
    id: "AggregatedMeasurementBucket",
    description:
      "Pre-folded bucket returned by the `aggregate=` list modes instead of a stored row.",
  });

/** `meta` on every `GET /api/measurements` response mode. */
const listMeasurementsMeta = z
  .object({
    total: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    dayKey: z
      .string()
      .optional()
      .describe("Echoed on the per-sample drill-down modes."),
    groupBy: z
      .enum(["day", "night"])
      .optional()
      .describe("Set on the collapsed day-sum / per-night modes."),
    aggregate: z
      .string()
      .optional()
      .describe("Set on the aggregate modes — the requested grain."),
    droppedDuplicates: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Rows discarded by the cross-source canonical picker on the day-collapse mode.",
      ),
  })
  .meta({ id: "ListMeasurementsMeta" });

// ── Sleep night (v1.11.5 hypnogram source) ──────────────────────────

const sleepStageEnum = z.enum([
  "IN_BED",
  "AWAKE",
  "ASLEEP",
  "REM",
  "CORE",
  "DEEP",
]);

const sleepSegmentResource = z.object({
  stage: sleepStageEnum.nullable(),
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  minutes: z.number().int().nonnegative(),
});

const sleepSessionResource = z.object({
  night: z.string().describe("Wake-day key (YYYY-MM-DD)."),
  source: measurementSourceEnum.nullable(),
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  asleepMinutes: z.number().int().nonnegative(),
  inBedMinutes: z.number().int().nonnegative().nullable(),
  awakeMinutes: z.number().int().nonnegative().nullable(),
  awakenings: z.number().int().nonnegative(),
  reconstructed: z
    .boolean()
    .describe(
      "True when the source has no per-stage onset timestamps and the server synthesised a contiguous timeline in a fixed physiological order (WHOOP). The client renders the hypnogram but labels it an approximate layout and never recomputes. False for real-series sources (Apple Health / Withings / Fitbit).",
    ),
  stages: z.record(sleepStageEnum, z.number().int().nonnegative()),
  segments: z.array(sleepSegmentResource),
  sourceDiscrepancy: z
    .object({
      deltaMinutes: z
        .number()
        .int()
        .nonnegative()
        .describe(
          "Spread (max − min) of the disagreeing per-writer asleep totals, in minutes.",
        ),
      sources: z.array(
        z.object({
          source: z
            .string()
            .describe("MeasurementSource value of the writer bucket."),
          deviceType: z.string().nullable(),
          asleepMinutes: z.number().int().nonnegative(),
        }),
      ),
    })
    .nullable()
    .describe(
      "Non-null when two writer buckets reported clearly different asleep totals for this session (> 45 min apart and > 20% of the larger total). Observational only — the served totals stay the winning writer's; clients may show a discreet 'sources disagree' hint listing each bucket's total.",
    ),
});

const sleepNightResponse = z
  .object({
    night: z.string().nullable(),
    main: sleepSessionResource.nullable(),
    naps: z.array(sleepSessionResource),
  })
  .meta({
    id: "SleepNightResource",
    description:
      "One reconstructed sleep night: the main session's hypnogram segments + breakdown, plus same-wake-day naps surfaced separately.",
  });

// ── Sleep rhythm (sleep-debt + chronotype, v1.17.0) ──────────────────
//
// Server-authoritative timing signals computed off the SAME canonical night
// reconstruction the Sleep Score reads. Both carry a calm not-yet-ready state
// (`partial` / `learning`) below their night thresholds — they never assert a
// total / band off thin data.
const sleepDebtResource = z.object({
  state: z
    .enum(["partial", "ready"])
    .describe(
      "`partial` until enough tracked nights exist (calm 'still learning'); `ready` once the rolling window can assert a balance.",
    ),
  debtMinutes: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Outstanding sleep-debt balance over the window, in minutes, after caps. A night below need adds its shortfall; a night above need pays the balance down (floored at 0).",
    ),
  needMinutes: z
    .number()
    .int()
    .nonnegative()
    .describe("Age-based sleep need (minutes) used for the per-night deficit."),
  nightsCounted: z.number().int().nonnegative(),
  windowNights: z
    .number()
    .int()
    .positive()
    .describe("Rolling window length in nights."),
  nightsUntilReady: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Nights still needed before the debt is asserted (0 when ready).",
    ),
  source: measurementSourceEnum.describe(
    "v1.25.0 — the active source the debt is resolved FROM, picked off the user's `sleepDebt` source ladder. `COMPUTED` is HealthLog's own rolling-balance estimate (the only producer today); a provider value would be a device-native debt. Clients explain the figure when it is `COMPUTED`.",
  ),
});

const chronotypeBandEnum = z.enum([
  "extreme_early",
  "early",
  "intermediate",
  "late",
  "extreme_late",
]);

const chronotypeResource = z.object({
  state: z
    .enum(["learning", "ready"])
    .describe(
      "`learning` until enough free-day nights exist (no band asserted); `ready` once the free-day sample is large enough.",
    ),
  msfMinutes: z
    .number()
    .nullable()
    .describe("Mid-sleep on free days (minutes-of-day), null while learning."),
  msfScMinutes: z
    .number()
    .nullable()
    .describe(
      "Sleep-debt-corrected mid-sleep on free days (MSFsc, minutes-of-day), null while learning.",
    ),
  band: chronotypeBandEnum
    .nullable()
    .describe("MCTQ chronotype band off MSFsc, null while learning."),
  socialJetlagMinutes: z
    .number()
    .nullable()
    .describe(
      "Social jetlag = circular |MSF_work − MSF_free| in minutes, null when one side is missing.",
    ),
  freeNightsCounted: z.number().int().nonnegative(),
  workNightsCounted: z.number().int().nonnegative(),
  freeNightsUntilReady: z
    .number()
    .int()
    .nonnegative()
    .describe("Free-day nights still needed before a band is asserted."),
});

const averageSleepResource = z.object({
  state: z.enum(["partial", "ready"]),
  averageMinutes: z
    .number()
    .int()
    .nonnegative()
    .describe("Mean asleep minutes per scorable night (0 while partial)."),
  nightsCounted: z.number().int().nonnegative(),
  nightsUntilReady: z
    .number()
    .int()
    .nonnegative()
    .describe("Scorable nights still needed before the average is asserted."),
});

// Exported because `GET /api/dashboard/summary` carries the identical DTO on
// its `sleepRhythm` key — the route builds it from the same
// `computeSleepRhythmFromNights` call `/api/sleep/rhythm` uses. Two copies of
// the shape would be two things to keep in step.
export const sleepRhythmResponse = z
  .object({
    sleepDebt: sleepDebtResource,
    chronotype: chronotypeResource,
    averagePerNight: averageSleepResource,
  })
  .meta({
    id: "SleepRhythmResource",
    description:
      "Server-authoritative sleep-rhythm read: the outstanding sleep-debt balance over the rolling window + MCTQ chronotype (MSF/MSFsc band, social jetlag). Free vs work nights default to weekend = free in the user's timezone (no work calendar). A view over existing per-stage SLEEP_DURATION rows — no schema, no new type.",
  });

// ── Personal records ─────────────────────────────────────────────────
//
// `GET /api/personal-records` shipped as a schema-only contract so the native
// client could build its query path against a stable shape before the
// detection worker landed. It answers the stored rows verbatim — including
// `userId` and the provenance foreign key — because the handler passes the
// Prisma result straight to `apiSuccess` with no projection.

const personalRecordQuery = z
  .object({
    metricType: measurementTypeEnum
      .optional()
      .describe(
        "Restrict to one measurement type. A value outside the enum is DROPPED rather than refused — the read then covers every metric, which is indistinguishable from omitting the parameter.",
      ),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .default(100)
      .describe(
        "Row cap, 1..500, default 100. A non-integer, zero, negative or non-numeric value falls back to the default and a value above the ceiling clamps to 500 — none of them 422.",
      ),
  })
  .meta({ id: "PersonalRecordQuery" });

const personalRecordResource = z
  .object({
    id: z.string(),
    userId: z
      .string()
      .describe(
        "The RECORD owner's id, which is not the caller's id on a delegated read.",
      ),
    metricType: measurementTypeEnum,
    metricSlot: z
      .string()
      .nullable()
      .describe(
        "Per-sport-type bucket for workout-driven records (e.g. `running_5km_time`). Null for a plain measurement-driven record, where the metric type alone is the dimension.",
      ),
    direction: z
      .enum(["MAX", "MIN"])
      .describe(
        "Which way is better for this metric: `MAX` for steps / VO2 max / HRV / distance / daylight, `MIN` for resting heart rate / body fat / audio exposure.",
      ),
    value: z.number(),
    unit: z.string(),
    achievedAt: z.iso
      .datetime({ offset: true })
      .describe(
        "When the record was set. The list orders on this, newest first.",
      ),
    sourceMeasurementId: z
      .string()
      .nullable()
      .describe(
        "The measurement row that achieved the record. Nulled rather than cascaded when that measurement is deleted, so the historical fact survives its source.",
      ),
    source: measurementSourceEnum,
    externalId: z.string().nullable(),
    createdAt: z.iso
      .datetime({ offset: true })
      .describe(
        "When the detection worker wrote the row — distinct from `achievedAt`, which is when the reading happened.",
      ),
  })
  .meta({
    id: "PersonalRecord",
    description:
      "One personal record: the best value a metric (optionally within a per-sport slot) has reached, in the direction that counts as better for it.",
  });

// ── Time-series adapter (iOS chart source) ───────────────────────────
//
// v1.16.16 — documents the long-shipped `GET /api/measurements/series`
// the iOS charts read off. The response is described AS-IS: `points`
// carry `id`/`at`/`value`/`secondary` (the route's wire field names),
// not the canonical `measuredAt`. `secondary` pairs the diastolic value
// for `bloodPressure`; `sleepStages` is per-night stage hours for `sleep`
// and null otherwise. `unit` is the resolved per-kind token (glucose +
// sleep resolve at request time to the user's display unit / hours).
const seriesKindEnum = z.enum([
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
  "restingHeartRate",
  "heartRateVariability",
  "vo2Max",
]);

const seriesQuerySchema = z.object({
  kind: seriesKindEnum,
  days: z.coerce
    .number()
    .int()
    .min(1)
    .max(3650)
    .optional()
    .default(30)
    .describe(
      "Look-back window in days (1..3650, default 30). `sleep` is internally capped to 365 regardless of the requested range.",
    ),
});

const seriesPointSchema = z.object({
  id: z
    .string()
    .describe("Measurement row id, or `sleep:<wake-day>` for a sleep night."),
  at: z.iso.datetime({ offset: true }).describe("Point timestamp (ISO-8601)."),
  value: z.number().describe("Primary value in the top-level `unit`."),
  secondary: z
    .number()
    .nullable()
    .describe(
      "Diastolic value for `kind=bloodPressure` (paired within ±5 min); null for every other kind.",
    ),
  sleepStages: z
    .record(z.string(), z.number())
    .nullable()
    .optional()
    .describe(
      "Per-stage hours for a `kind=sleep` night (CORE/DEEP/REM/…); null/absent for non-sleep kinds.",
    ),
  valueMin: z
    .number()
    .nullable()
    .optional()
    .describe(
      "v1.19.2 (iOS #34 extension) — per-point MINIMUM for `kind=pulse`. On an aggregated hourly heart-rate bucket `value` is the hour's average and this is the hour's low; null on a per-sample PULSE row and absent for every other kind.",
    ),
  valueMax: z
    .number()
    .nullable()
    .optional()
    .describe(
      "v1.19.2 (iOS #34 extension) — per-point MAXIMUM for `kind=pulse`. On an aggregated hourly heart-rate bucket `value` is the hour's average and this is the hour's high; null on a per-sample PULSE row and absent for every other kind.",
    ),
});

const seriesResponse = z
  .object({
    kind: seriesKindEnum,
    unit: z
      .string()
      .describe(
        "Resolved unit token for `value`. `glucose` follows the user's mg/dL|mmol/L preference; `sleep` is `h` (per-night time-asleep in hours).",
      ),
    points: z.array(seriesPointSchema),
    stats: z
      .object({
        mean: z.number(),
        min: z.number(),
        max: z.number(),
        stdDev: z.number(),
        count: z.number().int().nonnegative(),
      })
      .describe("Summary over the returned points; all-zero when empty."),
  })
  .meta({
    id: "MeasurementsSeriesResponse",
    description:
      "iOS-friendly per-kind time series: one point per reading (or per reconstructed night for `sleep`), an explicit `unit` token, and a summary `stats` block.",
  });

// ── Batched daily series (v1.18.6 dashboard fetch coalescing) ────────
//
// Returns every requested MeasurementType's rollup-backed daily series
// in one response so the dashboard chart row does a single round-trip
// instead of one per chart. Each row mirrors the daily-aggregate shape
// `GET /api/measurements?aggregate=daily&source=rollup` emits.
const seriesBatchRowSchema = z.object({
  type: measurementTypeEnum,
  value: z.number().describe("Daily mean (spot metrics) or SUM (cumulative)."),
  measuredAt: z.iso
    .datetime({ offset: true })
    .describe("Day-bucket start (ISO-8601)."),
  count: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Underlying raw-row count for the bucket."),
  minValue: z
    .number()
    .nullable()
    .optional()
    .describe("Per-day minimum (spot metrics only; absent for cumulative)."),
  maxValue: z
    .number()
    .nullable()
    .optional()
    .describe("Per-day maximum (spot metrics only; absent for cumulative)."),
});

const seriesBatchResponse = z
  .object({
    series: z
      .record(measurementTypeEnum, z.array(seriesBatchRowSchema))
      .describe("Per-type daily series, keyed by MeasurementType."),
  })
  .meta({
    id: "MeasurementsSeriesBatchResponse",
    description:
      "Batched daily series — one rollup-backed series per requested type.",
  });

export const measurementPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/measurements/series-batch": {
    get: {
      tags: ["Measurements"],
      summary: "Batched daily series (dashboard fetch coalescing)",
      description:
        "Returns the rollup-backed daily series for every requested MeasurementType in ONE response, so the dashboard chart row does a single round-trip instead of one self-fetch per chart. Each per-type series is byte-identical with `GET /api/measurements?aggregate=daily&source=rollup` for the same window. SLEEP_DURATION is not served here (it rides the per-night reconstruction at `/api/measurements/series?kind=sleep`). Auth via cookie or Bearer.",
      requestParams: {
        query: seriesBatchQuerySchema,
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Per-type daily series.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                seriesBatchResponse,
                "GetMeasurementsSeriesBatchResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/measurements/series": {
    get: {
      tags: ["Measurements"],
      summary: "Per-kind time series (iOS chart source)",
      description:
        "Maps a camelCase `kind` to the canonical MeasurementType(s) and returns an ordered point series with an explicit `unit` token and a summary `stats` block. `bloodPressure` pairs systolic + diastolic (`secondary`) within ±5 min so one fetch renders the dual-line chart; `sleep` collapses per-stage rows into one per-night point carrying time-asleep in hours (`sleepStages` holds the per-stage breakdown) and is internally capped to 365 days. `glucose` values + `unit` resolve to the user's mg/dL|mmol/L preference. Auth via cookie or Bearer.",
      requestParams: {
        query: seriesQuerySchema,
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Resolved series.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                seriesResponse,
                "GetMeasurementsSeriesResponse",
              ),
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
        ...recordRefusal(),
        "200": {
          description: "Measurement page.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  measurements: z.array(
                    z.union([measurementResource, aggregatedMeasurementBucket]),
                  ),
                  meta: listMeasurementsMeta,
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
      summary: "Create one measurement (or a small array)",
      description:
        "Single ingest. The body may also be a bare ARRAY of the same objects — the mode the iOS client uses for a combined blood-pressure + pulse or dual-value glucose write — in which case `data` is the array of created rows in request order. Use `/api/measurements/batch` for Apple Health upload streams.\n\n" +
        "Also reachable with a narrow `measurements:write` Bearer, which is the supported way to push readings from a scale, a watch bridge or a home-automation rule. That credential is confined to its owner's own record — a request carrying the account selector is refused 403 before any sharing grant is read, however the record is actually shared — and it may not attribute a source at all: rows it writes carry `source: EXTERNAL`, resolved from the credential, so a bridged reading stays distinguishable from a hand-typed one. A body naming ANY source, `MANUAL` included, is refused 422 (`measurement.create.source_not_permitted`). The GET on this same path, and the PUT and DELETE beside it, name no scope and so refuse it — though the rows themselves stay editable by their owner, unlike a connected provider's.",
      parameters: [idempotencyKeyParameter],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: z.union([
              createMeasurementSchema,
              z.array(createMeasurementSchema),
            ]),
          },
        },
      },
      responses: {
        ...idempotentWrite(),
        ...recordRefusal(),
        "201": {
          description:
            "Created. A single resource for the object body; an array of resources, in request order, for the array body.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.union([measurementResource, z.array(measurementResource)]),
                "CreateMeasurementResponse",
              ),
            },
          },
        },
        "409": {
          description:
            "A measurement with this data already exists — the `(userId, type, source, externalId)` dedup index rejected the write.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        // After the spread: `stdResponses` carries a generic 422 that would
        // otherwise overwrite this one.
        ...stdResponses,
        "422": {
          description:
            "Validation failed, or (`measurement.create.source_not_permitted`) a narrow `measurements:write` credential named a source — any source. Refused rather than relabelled, so the caller can fix the payload instead of discovering rows it did not ask for.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/measurements/{id}": {
    get: {
      tags: ["Measurements"],
      summary: "Measurement detail",
      description:
        "Single stored row, scoped to the caller. A row owned by another user surfaces as 404 (existence channel sealed).",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Measurement.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                measurementResource,
                "GetMeasurementResponse",
              ),
            },
          },
        },
        "404": {
          description: "Measurement not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Measurements"],
      summary: "Update a measurement",
      description:
        "Edits a manually entered row. Rows owned by a connected source are refused with 409 `measurement.update.server_owned_source`; a timestamp collision with an existing row is refused with 409 `measurement.duplicate_timestamp`.",
      requestParams: { path: z.object({ id: z.string() }) },
      requestBody: {
        required: true,
        content: { "application/json": { schema: updateMeasurementSchema } },
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Updated measurement.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                measurementResource,
                "UpdateMeasurementResponse",
              ),
            },
          },
        },
        "404": {
          description: "Measurement not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description:
            "Refused: the row comes from a connected source (`meta.errorCode` = `measurement.update.server_owned_source`), or another row already carries this timestamp (`measurement.duplicate_timestamp`).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Measurements"],
      summary: "Delete a measurement",
      description:
        "Soft-deletes the row (tombstone) so paired clients can reconcile the deletion.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Deleted.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ deleted: z.literal(true) }),
                "DeleteMeasurementResponse",
              ),
            },
          },
        },
        "404": {
          description: "Measurement not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/measurements/batch": {
    post: {
      parameters: [idempotencyKeyParameter],
      tags: ["Measurements"],
      summary: "Apple Health batch ingest",
      description:
        "Up to 500 HealthKit entries per call. Idempotent via the `Idempotency-Key` header (replay window 24h). Per-entry status lets the iOS client advance its sync cursor accurately. v1.4.25 W8c adds an optional `deviceType` per entry — feed it from `HKDevice.model` so the cross-source canonical picker can break Apple-Watch-vs-iPhone ties; null/absent stays backward-compatible with v1.4.23 clients.\n\n" +
        "Also reachable with a narrow `measurements:write` Bearer, for a bridge that is not the phone. Such a credential writes only on its owner's own record; its entries are attributed `EXTERNAL` and it may not name a source itself, so an entry carrying one — `MANUAL` and `APPLE_HEALTH` alike — is refused 422 (`measurement.batch.source_not_permitted`). `EXTERNAL` also gives those writes their own `(userId, type, source, externalId)` namespace, so a bridge's ids can never collide with the phone's. The call does not advance the native sync checkpoint — `lastSyncedAt` means the CLIENT delivered what it was holding, and a third-party push is not that.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: batchPayloadSchema } },
      },
      responses: {
        ...idempotentWrite(),
        "200": {
          description: "Batch processed.",
          content: {
            "application/json": {
              schema: dataEnvelope(batchResponse, "BatchMeasurementsResponse"),
            },
          },
        },
        // After the spread: `stdResponses` carries a generic 422 that would
        // otherwise overwrite this one.
        ...stdResponses,
        "422": {
          description:
            "The batch exceeded the 500-entry limit (`measurement.batch.too_large`), failed validation, or (`measurement.batch.source_not_permitted`) carried an entry naming a source — any source — under a narrow `measurements:write` credential. Nothing was written in any of the three cases.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/measurements/by-external-ids": {
    delete: {
      tags: ["Measurements"],
      summary: "Delete measurements by external ID (iOS deletion-sync)",
      description:
        "Removes the user's HealthKit-ingested measurement rows (source `APPLE_HEALTH`) whose externalId is in the request list. Only app-minted rows are eligible: an externalId that maps to an integration- or manually-sourced row (a colliding externalUUID) is a no-op, never a delete. Rows owned by another user are silently skipped (cross-user 404 guard). Up to 500 externalIds per call.",
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
  "/api/measurements/bulk-delete": {
    post: {
      parameters: [idempotencyKeyParameter],
      tags: ["Measurements"],
      summary: "Bulk soft-delete measurements",
      description:
        "Soft-deletes (tombstones) up to 200 of the caller's measurement rows in one call, mirroring the single-DELETE contract. Idempotent via the `Idempotency-Key` header; rate-limited `measurements:bulk-delete:<userId>`. Forged / foreign / already-deleted ids are silently skipped — `deleted` is the count of rows actually tombstoned. The deletions surface in `/api/sync/changes` as tombstones.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: bulkDeleteMeasurementsRequest },
        },
      },
      responses: {
        ...idempotentWrite(),
        ...recordRefusal(),
        "200": {
          description: "Bulk delete processed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                bulkDeleteMeasurementsResponse,
                "MeasurementsBulkDeleteResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/measurements/restore": {
    post: {
      parameters: [idempotencyKeyParameter],
      tags: ["Measurements"],
      summary: "Restore soft-deleted measurements",
      description:
        "Un-tombstones up to 200 of the caller's soft-deleted measurement rows in one call — the delete-Undo counterpart to `/api/measurements/bulk-delete`. Idempotent via the `Idempotency-Key` header; rate-limited `measurements:restore:<userId>`. Forged / foreign / not-deleted ids are silently skipped — `restored` is the count of rows actually un-tombstoned. The restored rows re-surface in `/api/sync/changes` as upserts.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: restoreMeasurementsRequest },
        },
      },
      responses: {
        ...idempotentWrite(),
        ...recordRefusal(),
        "200": {
          description: "Restore processed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                restoreMeasurementsResponse,
                "MeasurementsRestoreResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/sleep/night": {
    get: {
      tags: ["Measurements"],
      summary: "Reconstructed sleep night (hypnogram source, v1.11.5)",
      description:
        "Returns one night's reconstructed sleep session for the phase-progression (hypnogram) view: the canonical source's stage segments (each with an absolute start/end), the per-stage breakdown, asleep/in-bed/awake totals, the mid-sleep awakenings count, and same-wake-day naps surfaced separately. Session-clustered, keyed by the local wake day, collapsed to one source via the sleep priority ladder so two sources never overlay. `date` omitted returns the most recent night. A read-only view over existing per-stage SLEEP_DURATION rows — no schema, no new measurement type.",
      requestParams: {
        query: z.object({
          date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe(
              "Wake-day key (YYYY-MM-DD). Omit for the most recent night.",
            ),
        }),
      },
      responses: {
        "200": {
          description: "Reconstructed night.",
          content: {
            "application/json": {
              schema: dataEnvelope(sleepNightResponse, "SleepNightResponse"),
            },
          },
        },
        ...recordRefusal(MODULE_DISABLED_DESCRIPTION),
        ...stdResponses,
      },
    },
  },
  "/api/sleep/rhythm": {
    get: {
      tags: ["Measurements"],
      summary: "Sleep rhythm — sleep-debt + chronotype (v1.17.0)",
      description:
        "Returns the two server-authoritative sleep-timing signals the Sleep page + iOS render off the same canonical night reconstruction the Sleep Score uses: the outstanding `sleepDebt` balance over the rolling window (calm `partial` state under the night threshold) and MCTQ `chronotype` (MSF/MSFsc band + social jetlag, `learning` state until enough free-day nights exist). Free vs work nights default to weekend = free in the user's timezone (no work calendar). A read-only view over existing per-stage SLEEP_DURATION rows — no schema, no new measurement type.",
      responses: {
        "200": {
          description: "Sleep-debt + chronotype DTO.",
          content: {
            "application/json": {
              schema: dataEnvelope(sleepRhythmResponse, "SleepRhythmResponse"),
            },
          },
        },
        ...recordRefusal(MODULE_DISABLED_DESCRIPTION),
        ...stdResponses,
      },
    },
  },
  "/api/personal-records": {
    get: {
      tags: ["Measurements"],
      summary: "List the record's personal records",
      description:
        "Returns the account's personal-record rows, `achievedAt` descending. Both query parameters are FORGIVING rather than strict: an unrecognised `metricType` is dropped (the read falls back to every metric) and an unusable `limit` clamps to the default instead of 422-ing, so a loosely-typed client filter cannot take the page down. Rows are the stored entities verbatim, including `userId` and the provenance `sourceMeasurementId`. Delegable at READ level over the `measurements` section. Not module-gated: the list spans metrics from several modules and is filtered by the caller's `metricType`, not by the account's module map — a record achieved under a metric whose module is now off is still returned. Cookie or Bearer auth.",
      requestParams: { query: personalRecordQuery },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The personal-record rows (possibly empty).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.array(personalRecordResource),
                "PersonalRecordListEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};
