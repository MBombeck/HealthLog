/**
 * The wire of the Android Health Connect sync (`/api/health-connect/*`).
 *
 * The app reads Health Connect and serialises; it never translates. A spot
 * reading's `fields` carry the column names and units of the Health Connect
 * export (`INSTANT_SPECS` in `@/lib/import/health-connect/mapper`): grams,
 * mmHg, mmol/L, °C, the integer codes. The server builds an export-shaped row
 * from them and maps it with the same function the export import uses, so the
 * two cannot drift apart.
 *
 * The batch envelope parses every item as `unknown` and each item on its own
 * afterwards (`parseHealthConnectRecord`), so one malformed record answers
 * `rejected` at its index instead of refusing the batch around it.
 */
import { z } from "zod/v4";

import { isoDateTime } from "@/lib/validations/datetime";

/** Items per batch, over records, aggregates and deletes together. */
export const HC_SYNC_MAX_ITEMS = 500;
/** Heart-rate samples per batch, over every record in it. */
export const HC_SYNC_MAX_SAMPLES = 5000;
/** Body ceiling of a batch. */
export const HC_SYNC_MAX_BYTES = 4 * 1024 * 1024;

/** The one-time pairing code: `hcp_` and 32 lowercase hex characters. */
export const HC_PAIRING_CODE_PATTERN = /^hcp_[0-9a-f]{32}$/;

/** A Health Connect record id (`metadata.id`), a UUID. */
const HC_UUID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Lowercased, because the export spells its UUIDs from the raw bytes in
 * lowercase and the two must meet on the same `hc:<uuid>` row.
 */
export const hcRecordId = z
  .string()
  .regex(HC_UUID)
  .transform((v) => v.toLowerCase())
  .meta({
    description:
      "The record's Health Connect `metadata.id`, a UUID. Matched case-insensitively.",
  });

/** A zone offset in seconds, as Health Connect's `ZoneOffset.totalSeconds`. */
const zoneOffset = z.number().int().min(-64_800).max(64_800);

/** The spot-reading record types, each with the export table it mirrors. */
export const HC_INSTANT_RECORD_TABLES = {
  WeightRecord: "weight_record_table",
  BodyFatRecord: "body_fat_record_table",
  LeanBodyMassRecord: "lean_body_mass_record_table",
  BloodPressureRecord: "blood_pressure_record_table",
  RestingHeartRateRecord: "resting_heart_rate_record_table",
  HeartRateVariabilityRmssdRecord: "heart_rate_variability_rmssd_record_table",
  OxygenSaturationRecord: "oxygen_saturation_record_table",
  RespiratoryRateRecord: "respiratory_rate_record_table",
  BloodGlucoseRecord: "blood_glucose_record_table",
  BodyTemperatureRecord: "body_temperature_record_table",
  Vo2MaxRecord: "vo2_max_record_table",
} as const;

export type HcInstantRecordType = keyof typeof HC_INSTANT_RECORD_TABLES;

/** Every record type the batch accepts, in the order `state` lists them. */
export const HC_SYNC_RECORD_TYPES = [
  ...(Object.keys(HC_INSTANT_RECORD_TABLES) as HcInstantRecordType[]),
  "HeartRateRecord",
  "SleepSessionRecord",
  "ExerciseSessionRecord",
] as const;

export type HcSyncRecordType = (typeof HC_SYNC_RECORD_TYPES)[number];

/** Day-total aggregate metrics, from `aggregateGroupByPeriod`. */
export const HC_DAILY_METRICS = [
  "STEPS_COUNT_TOTAL",
  "ACTIVE_CALORIES_TOTAL",
  "DISTANCE_TOTAL",
] as const;

const recordBase = {
  id: hcRecordId,
  package: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .meta({ description: "`metadata.dataOrigin.packageName`." }),
  deviceType: z
    .number()
    .int()
    .min(0)
    .max(64)
    .optional()
    .meta({
      description: "`metadata.device.type` (Health Connect `Device.TYPE_*`).",
    }),
  lastModified: isoDateTime().optional(),
};

/** One export column value: a number, or a TEXT column holding an integer. */
const fieldValue = z.union([z.number(), z.string().max(64), z.null()]);

export const hcInstantRecordSchema = z
  .object({
    ...recordBase,
    type: z.enum(
      Object.keys(HC_INSTANT_RECORD_TABLES) as [
        HcInstantRecordType,
        ...HcInstantRecordType[],
      ],
    ),
    time: isoDateTime(),
    zoneOffsetSeconds: zoneOffset.optional(),
    fields: z
      .record(z.string().min(1).max(64), fieldValue)
      .refine((v) => Object.keys(v).length <= 16, {
        message: "At most 16 fields",
      })
      .meta({
        description:
          "The record's values under the Health Connect export's column names and units: `weight` and `mass` in grams, `percentage` 0–100, `systolic`/`diastolic` mmHg, `beats_per_minute`, `heart_rate_variability_millis`, `rate`, `level` mmol/L with `relation_to_meal` (int), `temperature` °C, `vo2_milliliters_per_minute_kilogram`. Unknown fields are ignored.",
      }),
  })
  .strict()
  .meta({ id: "HealthConnectInstantRecord" });

const interval = {
  start: isoDateTime(),
  end: isoDateTime(),
  startZoneOffsetSeconds: zoneOffset.optional(),
  endZoneOffsetSeconds: zoneOffset.optional(),
};

export const hcHeartRateRecordSchema = z
  .object({
    ...recordBase,
    type: z.literal("HeartRateRecord"),
    ...interval,
    samples: z
      .array(
        z
          .object({
            time: isoDateTime(),
            bpm: z.number().min(0).max(1000),
          })
          .strict(),
      )
      .max(HC_SYNC_MAX_SAMPLES),
  })
  .strict()
  .meta({ id: "HealthConnectHeartRateRecord" });

export const hcSleepRecordSchema = z
  .object({
    ...recordBase,
    type: z.literal("SleepSessionRecord"),
    ...interval,
    stages: z
      .array(
        z
          .object({
            start: isoDateTime(),
            end: isoDateTime(),
            stage: z
              .number()
              .int()
              .min(0)
              .max(64)
              .meta({ description: "`SleepSessionRecord.STAGE_TYPE_*`." }),
          })
          .strict(),
      )
      .max(500)
      .default([]),
  })
  .strict()
  .meta({ id: "HealthConnectSleepSessionRecord" });

export const hcExerciseRecordSchema = z
  .object({
    ...recordBase,
    type: z.literal("ExerciseSessionRecord"),
    ...interval,
    exerciseType: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .meta({ description: "`ExerciseSessionRecord.EXERCISE_TYPE_*`." }),
  })
  .strict()
  .meta({ id: "HealthConnectExerciseSessionRecord" });

export const hcRecordSchema = z
  .discriminatedUnion("type", [
    hcInstantRecordSchema,
    hcHeartRateRecordSchema,
    hcSleepRecordSchema,
    hcExerciseRecordSchema,
  ])
  .meta({ id: "HealthConnectRecord" });

export type HcRecord = z.infer<typeof hcRecordSchema>;
export type HcInstantRecord = z.infer<typeof hcInstantRecordSchema>;

const dayKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const hcDailyAggregateSchema = z
  .object({
    metric: z.enum(HC_DAILY_METRICS),
    day: dayKey.meta({
      description: "The local calendar day the total covers, `YYYY-MM-DD`.",
    }),
    value: z.number().min(0).meta({
      description:
        "Steps as a count, active energy in small calories (`Energy.inCalories`), distance in metres.",
    }),
    computedAt: isoDateTime().optional().meta({
      description:
        "When the phone computed the total. A total computed earlier than the stored one is answered `skipped`, reason `stale`.",
    }),
  })
  .strict()
  .meta({ id: "HealthConnectDailyAggregate" });

export const hcHourlyHeartRateSchema = z
  .object({
    metric: z.literal("HEART_RATE_BPM"),
    hour: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}$/)
      .meta({ description: "The local hour, `YYYY-MM-DDTHH`." }),
    zoneOffsetSeconds: zoneOffset,
    avg: z.number().min(0).max(1000),
    min: z.number().min(0).max(1000),
    max: z.number().min(0).max(1000),
  })
  .strict()
  .meta({ id: "HealthConnectHourlyHeartRate" });

export const hcAggregateSchema = z
  .discriminatedUnion("metric", [
    hcDailyAggregateSchema.extend({ metric: z.literal("STEPS_COUNT_TOTAL") }),
    hcDailyAggregateSchema.extend({
      metric: z.literal("ACTIVE_CALORIES_TOTAL"),
    }),
    hcDailyAggregateSchema.extend({ metric: z.literal("DISTANCE_TOTAL") }),
    hcHourlyHeartRateSchema,
  ])
  .meta({ id: "HealthConnectAggregate" });

export type HcAggregate = z.infer<typeof hcAggregateSchema>;

/** The envelope the route parses; items are checked one by one after it. */
export const hcBatchEnvelopeSchema = z
  .object({
    phase: z.enum(["live", "backfill"]),
    records: z.array(z.unknown()).max(HC_SYNC_MAX_ITEMS).default([]),
    aggregates: z.array(z.unknown()).max(HC_SYNC_MAX_ITEMS).default([]),
    deletes: z.array(z.unknown()).max(HC_SYNC_MAX_ITEMS).default([]),
  })
  .strict();

/** The same body as documented: every item in its full shape. */
export const hcBatchRequestSchema = z
  .object({
    phase: z.enum(["live", "backfill"]).meta({
      description:
        "`live` for change-token reads, `backfill` for the first import. Only `live` moves the device's delivery stamps the stall rule reads.",
    }),
    records: z.array(hcRecordSchema).max(HC_SYNC_MAX_ITEMS).optional(),
    aggregates: z.array(hcAggregateSchema).max(HC_SYNC_MAX_ITEMS).optional(),
    deletes: z.array(hcRecordId).max(HC_SYNC_MAX_ITEMS).optional().meta({
      description:
        "Record ids Health Connect reported deleted. Each removes the rows that record became (a spot reading, a heart-rate series, a sleep session's stages, a workout).",
    }),
  })
  .strict()
  .meta({
    id: "HealthConnectBatchRequest",
    description: `At most ${HC_SYNC_MAX_ITEMS} items over records, aggregates and deletes together, ${HC_SYNC_MAX_SAMPLES} heart-rate samples, and ${HC_SYNC_MAX_BYTES} bytes.`,
  });

export const HC_ITEM_STATUSES = [
  "inserted",
  "updated",
  "unchanged",
  "skipped",
  "rejected",
  "deleted",
  "not_found",
] as const;

export type HcItemStatus = (typeof HC_ITEM_STATUSES)[number];

export const hcBatchResultSchema = z
  .object({
    accepted: z
      .number()
      .int()
      .nonnegative()
      .meta({ description: "Items not answered `rejected`." }),
    results: z.array(
      z
        .object({
          kind: z.enum(["record", "aggregate", "delete"]),
          index: z.number().int().nonnegative(),
          status: z.enum(HC_ITEM_STATUSES),
          reason: z.string().optional().meta({
            description:
              "Why an item was skipped or rejected: `out_of_range`, `same_reading_other_source`, `same_instant_exists`, `folded_window`, `hour_already_raw`, `deleted_in_healthlog`, `stale`, `skipped_package`, `type_not_wanted`, `unknown_stage`, `out_of_bed`, `unmapped_stage`, `no_value`, `malformed`.",
          }),
        })
        .strict(),
    ),
  })
  .meta({
    id: "HealthConnectBatchResult",
    description:
      "One result per item, index-aligned per kind. Neither `rejected` nor a skip holds a change token back; only a non-2xx answer does.",
  });

export const hcPairRequestSchema = z
  .object({
    code: z.string().regex(HC_PAIRING_CODE_PATTERN),
    installId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{16,128}$/)
      .meta({
        description:
          "A random id the app generates once per install. It names the device in every later `X-Device-Id` header.",
      }),
    deviceModel: z.string().trim().min(1).max(128).optional(),
    appVersion: z.string().trim().min(1).max(32).optional(),
  })
  .strict()
  .meta({ id: "HealthConnectPairRequest" });

export const hcPairResultSchema = z
  .object({
    token: z.string().meta({
      description:
        "An `hlk_` Bearer token with the single scope `health-connect:write`. Shown once.",
    }),
    tokenExpiresAt: isoDateTime(),
    deviceId: z.string(),
    server: z.object({ version: z.string() }),
  })
  .meta({ id: "HealthConnectPairResult" });

export const hcPairingResultSchema = z
  .object({
    code: z.string().regex(HC_PAIRING_CODE_PATTERN),
    expiresAt: isoDateTime(),
    link: z.string().meta({
      description:
        "`healthlog-sync://pair?server=<origin>&code=<code>`, the payload of the QR code.",
    }),
  })
  .meta({ id: "HealthConnectPairingResult" });

export const hcStateResultSchema = z
  .object({
    serverNow: isoDateTime(),
    tokenExpiresAt: isoDateTime().nullable(),
    wantedTypes: z.array(z.string()).meta({
      description:
        "Record types the server takes. A record of any other type is answered `skipped`, reason `type_not_wanted`.",
    }),
    wantedAggregates: z.array(z.string()),
    skipPackages: z.array(z.string()).meta({
      description:
        "Apps whose data reaches HealthLog through a direct integration. Their records are answered `skipped`, reason `skipped_package`; the app need not send them.",
    }),
    rawHeartRateDays: z.number().int().positive(),
    rawHeartRateFrom: isoDateTime().meta({
      description:
        "Heart rate before this instant is sent as `HEART_RATE_BPM` hourly aggregates, from it on as samples.",
    }),
    historyFrom: isoDateTime()
      .nullable()
      .meta({
        description: "How far back to read; null is the whole history.",
      }),
    types: z
      .record(
        z.string(),
        z.object({ newestAt: isoDateTime().nullable() }).strict(),
      )
      .meta({
        description:
          "Per record type, the newest reading the server holds from Health Connect, null when it holds none.",
      }),
    limits: z
      .object({
        maxItems: z.number().int(),
        maxSamples: z.number().int(),
        maxBytes: z.number().int(),
        batchesPerMinute: z.number().int(),
        backfillWindowDays: z.number().int(),
        maxInFlight: z.number().int(),
      })
      .strict(),
  })
  .meta({ id: "HealthConnectState" });
