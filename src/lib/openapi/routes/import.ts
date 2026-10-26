/**
 * OpenAPI route table — data import (CSV since v1.17.1, JSON since the
 * publication sweep that closed the create/poll gap).
 *
 * The CSV importer is the cold-start escape hatch for self-hosters migrating
 * from a spreadsheet or another tracker. The JSON importer (`/api/import`)
 * restores the structure `GET /api/export/json` emits. The Apple-Health pair
 * (`/api/import/apple-health-export` + its status poll) takes the `export.zip`
 * the Health app produces and hands it to a background worker; iOS does not
 * call it — the native client's canonical ingest is
 * `POST /api/measurements/batch`, and this route exists for the person who
 * exports from the phone and uploads through the browser.
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import { glucoseContextEnum } from "@/lib/validations/measurement";
import { moodLevelEnum } from "@/lib/validations/mood";
import { SLEEP_STAGE_NAMES } from "@/lib/validations/sleep-stage-entry";
import { RhythmClassification } from "@/generated/prisma/enums";
import { moodContextWire } from "./mood";
import {
  dataEnvelope,
  errorEnvelope,
  measurementTypeEnum,
  stdResponses,
} from "./shared";
import { isoDateTime } from "@/lib/validations/datetime";
import {
  csvImportQuerySchema,
  labsCsvQuerySchema,
  medicationsCsvQuerySchema,
  recordImportResultSchema,
} from "@/lib/validations/record-import";

const RECORD_IMPORT_COMMON =
  "Body is the raw CSV file (`text/csv`, ≤ 16 MB), read as a stream: a UTF-8 byte-order mark is dropped, the separator is `,`, `;` or a tab, quoted fields may hold separators and line breaks. Every row is checked on its own and a refused row is reported by line with a reason, never guessed (a number or date that reads two ways is refused). Re-uploading the same file writes nothing: every row is reported as a duplicate. `dryRun=1` checks the whole file without writing and returns the first rows as they would be stored; it spends a separate bucket of 30 checks an hour, the import itself the shared 5-an-hour `import:` bucket. Owner only; refused with `module.disabled` when the module is switched off. An unknown query parameter is refused with 422, so a misspelt `dryRun` never writes.";

function recordImportResponses(id: string) {
  return {
    "200": {
      description: "Per-file and per-row outcome.",
      content: {
        "application/json": {
          schema: dataEnvelope(recordImportResultSchema, id),
        },
      },
    },
    ...stdResponses,
    "403": {
      description:
        "`module.disabled`: the module the import writes to is switched off.",
      content: { "application/json": { schema: errorEnvelope } },
    },
    "413": {
      description: "`import.csv.too_large`: the file is larger than 16 MB.",
      content: { "application/json": { schema: errorEnvelope } },
    },
    "415": {
      description: "`import.csv.content_type`: the body is not `text/csv`.",
      content: { "application/json": { schema: errorEnvelope } },
    },
  };
}

const csvImportRowResult = z
  .object({
    line: z
      .number()
      .int()
      .describe("1-based source line number (the header is line 1)."),
    status: z.enum(["inserted", "updated", "skipped"]),
    reason: z
      .string()
      .optional()
      .describe(
        "Machine-readable reason for a non-inserted row (e.g. unknown_type, unknown_unit, missing_timezone_offset, value_out_of_range, implausible_timestamp, duplicate).",
      ),
  })
  .meta({ id: "CsvImportRowResult" });

const csvImportResponse = z
  .object({
    inserted: z.number().int(),
    updated: z.number().int(),
    skipped: z.number().int(),
    total: z
      .number()
      .int()
      .describe("Total data rows parsed (excludes header)."),
    dryRun: z.boolean(),
    rows: z.array(csvImportRowResult),
  })
  .meta({
    id: "CsvImportResponse",
    description:
      "Per-row import outcome. Mirrors the batch-route per-entry envelope. In `dryRun` mode no write runs and every valid row reports its projected `inserted` status.",
  });

// ── JSON import — mirrors `jsonImportSchema`
// (`src/lib/import/json/schema.ts`). The runtime side carries transforms and
// plausibility refinements the document restates in prose; its field set is
// held to this one by `json-import-field-coverage.test.ts`.

const jsonImportMeasurement = z
  .object({
    type: measurementTypeEnum,
    value: z
      .number()
      .describe(
        "Checked against the type's server-side plausibility range; an out-of-range value fails the whole request with 422.",
      ),
    valueMin: z
      .number()
      .optional()
      .describe(
        "Lower bound of a range reading (an hourly heart-rate statistic). Not above `valueMax`.",
      ),
    valueMax: z.number().optional().describe("Upper bound of a range reading."),
    unit: z.string(),
    measuredAt: isoDateTime().describe(
      "Bounded: no future instants beyond a 5-min clock-skew tolerance, nothing before 1900.",
    ),
    glucoseContext: glucoseContextEnum
      .optional()
      .describe(
        "Optional even on a BLOOD_GLUCOSE row — a sensor export classifies nothing per sample.",
      ),
    sleepStage: z
      .enum(SLEEP_STAGE_NAMES)
      .optional()
      .describe("A sleep row's stage."),
    rhythmClassification: z
      .enum(RhythmClassification)
      .optional()
      .describe(
        "The device's own verdict on an ECG, a rhythm alert or a steadiness reading.",
      ),
    deviceType: z
      .string()
      .min(1)
      .max(32)
      .optional()
      .describe("The writer of the reading (watch, phone)."),
    notes: z.string().optional().describe("Encrypted at rest."),
    externalId: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        "Source-stable id making re-import idempotent (upsert on `(userId, type, source=IMPORT, externalId)`; a re-import updates the row in place). Absent → first-write-wins create with a NULL key, which DOES duplicate on re-import. An unstable id (an object description or memory address that rotates per launch) skips THIS row, never the file.",
      ),
  })
  .meta({
    id: "JsonImportMeasurement",
    description: "One measurement row of a JSON import file.",
  });

const jsonImportMoodEntry = z
  .object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe("Local-day label, YYYY-MM-DD."),
    mood: moodLevelEnum,
    score: z
      .number()
      .int()
      .min(1)
      .max(5)
      .describe(
        "Stored as sent — the export format's own field. Pleasantness (`a1`) is never taken from this.",
      ),
    a1: z
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .describe("Pleasantness, 0–10. Absent → derived from `mood`."),
    a2: z.number().int().min(0).max(10).optional().describe("Stress, 0–10."),
    a3: z.number().int().min(0).max(10).optional().describe("Energy, 0–10."),
    a4: z
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .describe("Connection, 0–10."),
    a5: z
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .describe(
        "Stability, 0–10. `a2` to `a5` absent leave a row the import updates as it was.",
      ),
    tags: z
      .string()
      .optional()
      .describe("JSON-encoded array of tag strings, stored verbatim."),
    note: z
      .string()
      .max(500)
      .optional()
      .describe("The entry's note. Encrypted at rest."),
    loggedAt: isoDateTime()
      .optional()
      .describe(
        "Bounded like `measuredAt`. Absent → the server derives a stable per-row instant within the `date` day, so a re-import of the same file dedups instead of duplicating.",
      ),
    tz: z
      .string()
      .max(64)
      .optional()
      .describe(
        "IANA zone the `date` is anchored to. Absent → the legacy reading.",
      ),
    factors: z
      .array(
        z.object({
          key: z.string().max(60),
          rating: z.number().int().min(1).max(5),
        }),
      )
      .max(30)
      .optional()
      .describe(
        "Rated factors by key (the catalogue's, or the account's own as for `structuredTags`); replaces the entry's rated links. A key the account cannot resolve is dropped and named in `droppedFactorKeys`; a rating outside the factor's own scale skips the entry.",
      ),
    structuredTags: z
      .array(z.string().max(60))
      .max(30)
      .optional()
      .describe(
        "Ticked tags by key (the catalogue, the account's own, or one the file's `customMoodTags` brings); replaces the entry's tag links. An unresolvable key is dropped and named in `droppedTagKeys`.",
      ),
    context: moodContextWire
      .partial()
      .optional()
      .describe(
        "The day context; replaces the entry's context. `contactCircles` and `leisureCategories` are also read as the backup's JSON-encoded string.",
      ),
    externalId: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        "Source-stable id (e.g. a Daylio row id) making re-import idempotent (upsert on `(userId, source=IMPORT, externalId)`). Same stability rule as the measurement `externalId`: an unstable id skips the row.",
      ),
  })
  .meta({
    id: "JsonImportMoodEntry",
    description: "One mood-entry row of a JSON import file.",
  });

const jsonImportMoodTagCategory = z
  .object({
    id: z
      .string()
      .max(120)
      .optional()
      .describe(
        "The file's own id, read only to find the group a tag names in `categoryId`.",
      ),
    key: z.string().min(1).max(80),
    labelKey: z.string().min(1).max(120),
    icon: z.string().max(60).optional(),
    sortOrder: z.number().int().optional(),
    isActive: z.boolean().optional(),
    label: z.string().max(200).optional().describe("The group's own name."),
    labelEncrypted: z
      .string()
      .max(2000)
      .optional()
      .describe(
        "A disaster-recovery file's sealed name, used only when this server's keys open it.",
      ),
  })
  .meta({
    id: "JsonImportMoodTagCategory",
    description:
      "A mood-tag group the account made itself. Matched by `key`: a group the account has is used as it is, a missing one is created.",
  });

const jsonImportMoodTag = z
  .object({
    key: z.string().min(1).max(80),
    labelKey: z.string().min(1).max(120),
    categoryId: z
      .string()
      .min(1)
      .max(120)
      .describe(
        "The group's id in the file; a group the file does not carry falls back to the seeded `custom` group.",
      ),
    kind: z.enum(["BINARY", "RATED"]),
    isActive: z.boolean().optional(),
    icon: z.string().max(60).optional(),
    sortOrder: z.number().int().optional(),
    label: z.string().max(200).optional().describe("The tag's own name."),
    labelEncrypted: z
      .string()
      .max(2000)
      .optional()
      .describe(
        "A disaster-recovery file's sealed name, used only when this server's keys open it.",
      ),
    scaleMin: z.number().int().min(0).max(10).optional(),
    scaleMax: z.number().int().min(0).max(10).optional(),
    inverse: z.boolean().optional(),
  })
  .meta({
    id: "JsonImportMoodTag",
    description:
      "A mood tag the account made itself, a rated factor included. Matched by `key`: the account's own tag of that key is used and never overwritten (a different label is named in `keptMoodTagKeys`); a missing one is created, within the account's custom-tag cap; a key another account of this server holds comes over under a key derived from the account and the file's key, so a second import of the same file finds it.",
  });

const jsonImportRequest = z
  .object({
    measurements: z.array(jsonImportMeasurement).max(10000).optional(),
    moodEntries: z.array(jsonImportMoodEntry).max(10000).optional(),
    customMoodTagCategories: z
      .array(jsonImportMoodTagCategory)
      .max(10000)
      .optional(),
    customMoodTags: z.array(jsonImportMoodTag).max(10000).optional(),
  })
  .meta({
    id: "JsonImportRequest",
    description:
      "JSON import payload: the measurements and mood entries of the JSON export or the portable full backup, and the backup's own mood vocabulary the entries link to. Every section optional; up to 10 000 rows each.",
  });

const jsonImportStats = z
  .object({
    measurements: z
      .number()
      .int()
      .nonnegative()
      .describe("Measurement rows written (inserted or updated in place)."),
    moodEntries: z
      .number()
      .int()
      .nonnegative()
      .describe("Mood-entry rows written (inserted or updated in place)."),
    skipped: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Rows not written: duplicates of existing rows, rows carrying an unstable `externalId`, mood entries with a factor rating outside its own scale, and a backup's deletion records.",
      ),
    droppedTagKeys: z
      .array(z.string())
      .optional()
      .describe(
        "Tag keys of imported mood entries this account cannot resolve (another account's custom tag, a retired key). The entries landed without them. Present only when non-empty.",
      ),
    droppedFactorKeys: z
      .array(z.string())
      .optional()
      .describe(
        "Rated-factor keys this account cannot resolve, as `droppedTagKeys`.",
      ),
    keptMoodTagKeys: z
      .array(z.string())
      .optional()
      .describe(
        "Keys of the account's own tags the file names differently. The account's tag is kept as it is. Present only when non-empty.",
      ),
    keptMoodCategoryKeys: z
      .array(z.string())
      .optional()
      .describe("The same, for the account's own tag groups."),
  })
  .meta({
    id: "JsonImportStats",
    description: "Per-section outcome counts of a JSON import.",
  });

// v1.42 (#972) — Android Health Connect export import.
const healthConnectImportJob = z
  .object({
    jobId: z.string(),
    status: z
      .string()
      .describe(
        "`queued`, `unpacking`, `parsing`, `upserting`, `done` or `failed`. A plain string, like the Apple Health status.",
      ),
    startedAt: isoDateTime(),
    completedAt: isoDateTime().nullable(),
    uploadBytes: z.number().int(),
    progress: z
      .record(z.string(), z.unknown())
      .describe("Free-form phase progress. Shape is not part of the contract."),
    result: z
      .record(z.string(), z.unknown())
      .nullable()
      .describe(
        "The worker's outcome summary, null until it finishes. Counts only: `perType` (read / inserted / updated / unchanged / skipped per measurement type), `perApp` (records per Android package, `leftOut` for an app whose integration the account has connected), `workouts`, `sleep`, `cycle`, `nutrients`, `skipped` (reason → count), `warnings` (codes for tables or columns the importer could not read), `totals`. Never a value, a timestamp or text from the file.",
      ),
    failureReason: z
      .string()
      .nullable()
      .describe(
        "Why the job failed. Starts with a code the client can key on when the file was refused — `unsupported_version` (database older than version 9), `not_health_connect` (no `health_connect_export.db`, or not a Health Connect database), `unsafe_schema` (a record table is a view), `too_large`, `staging_missing` — else free text.",
      ),
  })
  .meta({ id: "HealthConnectImportJob" });

export const importPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/import/health-connect-export": {
    post: {
      tags: ["Import"],
      summary: "Upload a Health Connect export for background import",
      description:
        "Takes the ZIP the Android Health Connect app writes (it holds `health_connect_export.db`) and hands it to a background worker. The response is **202 with a `jobId`**; poll `GET /api/import/health-connect-export/status`. Body is `multipart/form-data` with the file under `file`, streamed to disk after authentication like the Apple Health upload. Re-uploading the same bytes resolves to the still-viable job and returns `idempotent: true`. Imported rows carry `source = HEALTH_CONNECT`. Cookie or wildcard Bearer.",
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: z.object({
              file: z
                .string()
                .describe(
                  "The Health Connect export ZIP, under the field name `file`.",
                ),
            }),
          },
        },
      },
      responses: {
        "202": {
          description:
            "Accepted and queued, or matched to a job already carrying these bytes.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  jobId: z.string(),
                  status: z.enum([
                    "queued",
                    "unpacking",
                    "parsing",
                    "upserting",
                    "done",
                  ]),
                  idempotent: z.boolean().optional(),
                }),
                "HealthConnectImportKickoffEnvelope",
              ),
            },
          },
        },
        "400": {
          description: "The request carried no body at all.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description:
            "An import for this account (Health Connect or Apple Health) is already queued or running. The upload was discarded. `errorCode` is `import.apple_health.busy` for either kind, `jobId` names the running job.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "413": {
          description:
            "The declared `Content-Length` exceeds the 1 GiB upload cap.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        "422": {
          description:
            "The multipart body could not be read: no `file` part, a malformed body, or more bytes than the cap. Whether the ZIP is a readable Health Connect export is decided by the worker and reported on the job (`status: failed`, `failureReason`).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "503": {
          description:
            "No background worker is bound, or the queue did not take the job, so nothing would run the import.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/import/health-connect-export/status": {
    get: {
      tags: ["Import"],
      summary: "The caller's latest Health Connect import",
      description:
        "The most recent Health Connect import job of the caller, or `null` when there has never been one.",
      responses: {
        "200": {
          description: "The latest job, or null.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ job: healthConnectImportJob.nullable() }),
                "HealthConnectImportStatusEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/import/csv": {
    post: {
      tags: ["Import"],
      summary: "Import measurements from CSV",
      description:
        "Bulk-import measurements from a CSV file (web cold-start escape hatch). Body is raw `text/csv` (≤ 16 MB, ≤ 10 000 valid rows). Header (order-independent): `type,value,unit,measuredAt[,glucoseContext,notes,externalId]`. `measuredAt` must carry an explicit ISO-8601 offset and is bounded (no future beyond a 5-min skew, no instant before 1900). Glucose accepts `mmol/L` (converted to canonical `mg/dL`); weight accepts `lb` (converted to `kg`). `glucoseContext` is optional on a `BLOOD_GLUCOSE` row — a blank cell stores no context, which is the normal shape of a continuous-sensor export; a non-empty value is still checked against the enum, and the column is refused on any other type. Re-uploading a file is idempotent. With an `externalId` column a row upserts on `(userId, type, source=IMPORT, externalId)`: a changed row is `updated`, an unchanged one is `skipped` with reason `duplicate` and not written. Without it a row is deduplicated on `(type, measuredAt)` and a repeat is `skipped` / `duplicate`. Writes commit in chunks rather than as one transaction; a failure part-way leaves earlier chunks written, and re-uploading the same file completes the rest. `?dryRun=1` validates + previews without writing. Shares the 5/hour `import:` rate bucket. An unknown query parameter is refused with 422, so a misspelt `dryRun` never writes.",
      requestParams: { query: csvImportQuerySchema },
      requestBody: {
        required: true,
        content: {
          "text/csv": {
            schema: {
              type: "string",
              example:
                "type,value,unit,measuredAt,glucoseContext,notes,externalId\nWEIGHT,80.5,kg,2026-05-01T08:00:00Z,,morning,\nBLOOD_GLUCOSE,5.3,mmol/L,2026-05-01T08:05:00+02:00,FASTING,,meter-001\nBLOOD_GLUCOSE,5.9,mmol/L,2026-05-01T08:20:00+02:00,,,sensor-001",
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Per-row import outcome.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                csvImportResponse,
                "CsvImportResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
        "413": {
          description: "CSV exceeds the 16 MB limit.",
          content: {
            "application/json": {
              schema: dataEnvelope(z.null(), "CsvImportTooLargeEnvelope"),
            },
          },
        },
      },
    },
  },
  "/api/import/labs-csv": {
    post: {
      tags: ["Import"],
      summary: "Import lab results from CSV",
      description: `${RECORD_IMPORT_COMMON} Each row's name resolves to the account's marker the way a scanned report's rows do (name, alias, catalog name); a new analyte mints one marker from its first row. A numeric result needs a unit; one in another unit is converted when the conversion is known and keeps the printed value beside it, otherwise the row is refused with \`unit_mismatch\`. Any other text in the value column is a qualitative result. A date without a time is stored as that calendar date. At most 20 000 data rows.`,
      requestParams: { query: labsCsvQuerySchema },
      requestBody: {
        required: true,
        content: {
          "text/csv": {
            schema: {
              type: "string",
              example:
                "Analyte;Value;Unit;Date;Range\nHbA1c;5,4;%;01.03.2025;4,0-5,6\nUrine protein;negative;;01.03.2025;",
            },
          },
        },
      },
      responses: recordImportResponses("LabsCsvImportEnvelope"),
    },
  },
  "/api/import/medications-csv": {
    post: {
      tags: ["Import"],
      summary: "Import medications from CSV",
      description: `${RECORD_IMPORT_COMMON} Maps name, dose (as written), daily intake times, an as-needed mark and a start and end date; every other rhythm is set up afterwards in the app. A row needs times unless it is marked as needed. Each row is checked against the create route's own schema; a dated window opens a course. Reminders stay off unless \`reminders=1\`. A medication the record holds under the same name and dose is a duplicate. At most 500 data rows.`,
      requestParams: { query: medicationsCsvQuerySchema },
      requestBody: {
        required: true,
        content: {
          "text/csv": {
            schema: {
              type: "string",
              example:
                "name,dose,times,as needed,start,end\nRamipril,5 mg,08:00,,2025-01-01,\nIbuprofen,400 mg,,yes,,",
            },
          },
        },
      },
      responses: recordImportResponses("MedicationsCsvImportEnvelope"),
    },
  },
  "/api/import": {
    post: {
      tags: ["Import"],
      summary: "Import measurements and mood entries from JSON",
      description:
        "Imports the app's own files back: the JSON export (`GET /api/export?format=json`, read inside its `data` envelope) or the portable full backup (`GET /api/export/full-backup`). Every field either file writes for a reading or a mood entry is carried, apart from the row ids, the source and the sync bookkeeping; a backup's deletion records are skipped and counted. Up to 10 000 measurements plus 10 000 mood entries per call, body ≤ 16 MB. Rows carrying an `externalId` upsert idempotently (re-import updates in place); rows without one are first-write-wins and dedup against the existing unique keys, so an exact duplicate is `skipped` rather than doubled. A row with an unstable `externalId` is skipped while the rest of the file still lands. Every imported row stores `source = IMPORT`; a mood entry without `a1` derives pleasantness from its label. Writes are per-row, not transactional: on a mid-file write failure the response is 503 (`meta.errorCode` = `import.write_failed`, `meta.retryable` = true) with `meta.stats` carrying what landed — rows already written stay written, and a retry is only safe against duplication for rows that carry an `externalId`. Validation is fail-fast (the 422 carries the first issue's message, not the multi-issue envelope). Rate-limited 5/hour per user (shared `import:` bucket with the CSV importer).",
      requestBody: {
        required: true,
        content: { "application/json": { schema: jsonImportRequest } },
      },
      responses: {
        "200": {
          description: "Import completed; per-section outcome counts.",
          content: {
            "application/json": {
              schema: dataEnvelope(jsonImportStats, "JsonImportStatsEnvelope"),
            },
          },
        },
        ...stdResponses,
        "413": {
          description: "Body exceeds the 16 MB limit.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "503": {
          description:
            "A write failed partway through the file. `meta.errorCode` = `import.write_failed`, `meta.retryable` = true, `meta.stats` carries the counts that landed before the failure. Rows already written stay written; retry the same file — rows with `externalId` re-import idempotently, rows without one may duplicate.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/import/apple-health-export": {
    post: {
      tags: ["Import"],
      summary: "Upload an Apple Health export.zip for background import",
      description:
        "Takes the `export.zip` the Health app produces and hands it to a background worker. The response is **202 with a `jobId`** — nothing has been imported yet. Poll `GET /api/import/apple-health-export/{jobId}/status` for the outcome.\n\nBody is `multipart/form-data` with the file under the field name `file`, capped at 1.5 GB. The upload is streamed straight to disk rather than buffered, computing a SHA-256 in the same pass; the declared `Content-Length` is checked first as a cheap pre-flight, but the streaming sink enforces the cap independently, so a missing or lying header does not get past it.\n\n**Idempotency is by CONTENT, not by an `Idempotency-Key`.** A 1 GB upload has no stable client-side key, so re-uploading the exact same bytes resolves to the previous job and returns `idempotent: true` without re-queueing. The match only covers a job that is still viable — queued, in flight, or done. A previously FAILED job is deliberately not matched, so the same export can always be retried with the same bytes rather than being tombstoned by its own failure.\n\nRate-limited to 3 uploads per minute per user, checked before the body is touched. Cookie or wildcard Bearer.",
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: z.object({
              file: z
                .string()
                .describe(
                  "The Apple Health `export.zip`, up to 1.5 GB. The field name is load-bearing — a part under any other name is not found and the request fails as a malformed upload.",
                ),
            }),
          },
        },
      },
      responses: {
        "202": {
          description:
            "Accepted and queued (or matched to a job already carrying these bytes). `status` is `queued` for a fresh job and the existing job's current status on a content match.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  jobId: z.string(),
                  status: z
                    .enum([
                      "queued",
                      "unpacking",
                      "parsing",
                      "upserting",
                      "done",
                    ])
                    .describe(
                      "`queued` on a fresh enqueue. On a content match it is whatever the matched job is doing now — never `failed`, because a failed job is not matched.",
                    ),
                  idempotent: z
                    .boolean()
                    .optional()
                    .describe(
                      "`true` only when these exact bytes matched a still-viable job and nothing was queued. ABSENT (not `false`) on a fresh enqueue.",
                    ),
                }),
                "AppleHealthImportKickoffEnvelope",
              ),
            },
          },
        },
        "400": {
          description: "The request carried no body at all.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "413": {
          description:
            "The declared `Content-Length` exceeds 1.5 GB. A body that exceeds the cap without declaring it is refused by the streaming sink instead, which surfaces as the 422 below.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        "409": {
          description:
            "An import for this account is already queued or running, and these bytes are not the ones it carries (the same bytes resolve to that job as a 202). `meta.errorCode` is `import.apple_health.busy` and `meta.jobId` names the running job; poll it, then upload again. The upload was discarded.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "422": {
          description:
            "The multipart body could not be streamed to disk — no `file` part, a malformed boundary, or the size cap tripped mid-stream. The message names the failure.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "429": {
          description: "More than 3 uploads in a minute for this user.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "503": {
          description:
            "No background worker is bound to this process, or the queue did not accept the job, so nothing will run it. The staged upload is discarded (and a created job is marked failed); retry once a worker is running.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/import/apple-health-export/{jobId}/status": {
    get: {
      tags: ["Import"],
      summary: "Poll an Apple Health import job",
      description:
        "The state of one import job. The web client polls every 2 seconds while the job is running and every 30 seconds once it is terminal.\n\nVisible to the job's owner, and to the admin who triggered it through the admin variant. Anyone else gets **404, not 403** — existence is not leaked to an outsider, so a 404 means either 'no such job' or 'not yours' and a client cannot tell which.\n\nThe `result` block is scrubbed before it is served: the ECG counters are re-read as bounded non-negative integers so a malformed worker payload cannot put arbitrary values on this wire.",
      requestParams: {
        path: z.object({
          jobId: z.string().describe("The id returned by the upload."),
        }),
      },
      responses: {
        "200": {
          description: "The job's current state.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  jobId: z.string(),
                  status: z
                    .string()
                    .describe(
                      "`queued`, `unpacking`, `parsing`, `upserting`, `done` or `failed`. A plain string on the wire, not a closed enum — the column is untyped and a future phase name would arrive here without a schema change.",
                    ),
                  startedAt: isoDateTime(),
                  completedAt: isoDateTime().nullable(),
                  uploadBytes: z.number().int(),
                  exportedAt: isoDateTime()
                    .nullable()
                    .describe(
                      "The instant the Health app stamped on the export itself, once the worker has read it. Null before then.",
                    ),
                  progress: z
                    .record(z.string(), z.unknown())
                    .describe(
                      "Free-form phase progress written by the worker. `{}` before the first phase reports. Shape is not part of the contract.",
                    ),
                  result: z
                    .record(z.string(), z.unknown())
                    .nullable()
                    .describe(
                      "The worker's outcome summary, null until it finishes. Free-form except for `ecg`, whose five counters (`discovered` / `imported` / `updated` / `skipped` / `failed`) are normalised to bounded non-negative integers before serving.",
                    ),
                  failureReason: z
                    .string()
                    .nullable()
                    .describe("Free text on `failed`; null otherwise."),
                }),
                "AppleHealthImportStatusEnvelope",
              ),
            },
          },
        },
        "404": {
          description:
            "No such job, or one the caller may not see. The two are indistinguishable on purpose.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
};
