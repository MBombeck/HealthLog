/**
 * OpenAPI route table — the backups-console routes that read a stored copy, and
 * the restore job they start.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 *
 * Most of `/api/admin/backups/*` is deliberately unpublished: it is a
 * cookie-only console, `requireAdmin()` refuses every Bearer caller, and a
 * contract nobody can call against is a contract nobody reads. These two are
 * here for the opposite reason. Both open the encrypted stored copy (pieces in
 * `data_backup_chunks`, or one value in `data_backups.data` for a copy written
 * before v1.39.2), and both therefore have a refusal an operator meets on
 * the day a key rotation went one step too far — the case
 * `docs/ops/encryption-key-rotation.md` warns about. That refusal is a promise
 * (422, `backup.payload.undecryptable`, nothing changed) rather than whatever
 * the handler happens to answer, and a promise belongs somewhere it can be
 * quoted from.
 *
 * The restore answers 202 and runs as a background job, so the two routes that
 * report on that job are published with it: a 202 without its status route is
 * half a contract.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import { dataEnvelope, errorEnvelope, idempotencyKeyParameter } from "./shared";

const restoreRequest = z
  .object({
    confirm: z.literal("RESTORE"),
    restoreInstanceSettings: z.boolean().optional(),
  })
  .meta({
    id: "AdminBackupRestoreRequest",
    description:
      "`confirm` is the literal typed gate; anything else is refused with 422 and nothing is read. `restoreInstanceSettings` defaults to false: the restore then replaces the snapshot owner's data tables and leaves the singleton instance settings — registration, MFA requirement, default locale and timezone, module availability, notification and AI configuration, document cap and quota — exactly as they are. Send `true` only when rebuilding a host from a snapshot, because those settings apply to every account on the installation.",
  });

const restoreSkipEntry = z
  .object({
    catalogue: z.string(),
    key: z.string(),
    links: z.number().int(),
  })
  .meta({
    id: "AdminBackupRestoreSkipEntry",
    description:
      "One catalogue key the file referenced and this instance could not resolve, with the number of links it cost.",
  });

const restoreQueued = z
  .object({
    jobId: z.string(),
    status: z.literal("queued"),
    statusUrl: z.string(),
  })
  .meta({
    id: "AdminBackupRestoreQueued",
    description:
      "The restore was accepted and queued. Poll `statusUrl` (`GET /api/admin/backups/restores/{jobId}`) for its progress and outcome.",
  });

const restorePhase = z
  .enum(["validating", "clearing", "measurements", "sections", "rebuilding"])
  .meta({
    id: "AdminBackupRestorePhase",
    description:
      "Where a running restore is: reading and checking the file, clearing the account's current data, writing the readings, writing the other sections, rebuilding the chart tiers after the commit.",
  });

const restoreProgress = z
  .object({
    measurementsChecked: z.number().int(),
    measurementsTotal: z.number().int().nullable(),
    measurementsWritten: z.number().int(),
    sectionsDone: z.number().int(),
    sectionsTotal: z.number().int(),
  })
  .meta({
    id: "AdminBackupRestoreProgress",
    description:
      "Counts only. `measurementsTotal` is null until the first read of the file has counted the readings.",
  });

const restoreFailure = z
  .object({
    code: z.string().meta({
      description:
        "Stable reason: `backup_not_found`, `backup_changed`, `backup.payload.undecryptable`, `schema_invalid`, `incompatible_schema_version`, `owner_mismatch`, `owner_not_found`, `backup.section.missing`, `document_ciphertext_missing`, `time_budget`, `transaction_failed`, `interrupted`, `not_started`, `enqueue_failed`, `failed_after_commit`, `unexpected`. Every code but `failed_after_commit` means the account was not changed.",
    }),
    message: z.string(),
    sections: z.array(z.string()).optional(),
  })
  .meta({
    id: "AdminBackupRestoreFailure",
    description:
      "Why the restore did not happen, in a sentence an operator can act on. `sections` names the missing sections for `backup.section.missing`.",
  });

const restoreJob = z
  .object({
    id: z.string(),
    userId: z.string(),
    username: z.string().nullable(),
    backupId: z.string(),
    restoreInstanceSettings: z.boolean(),
    status: z.enum(["queued", "running", "succeeded", "failed"]),
    phase: restorePhase.nullable(),
    progress: restoreProgress.nullable(),
    result: z
      .object({
        summary: z.record(z.string(), z.unknown()),
        skipped: z.object({
          catalogueKeys: z.array(restoreSkipEntry),
          links: z.number().int(),
        }),
        cleared: z.record(z.string(), z.number().int()),
      })
      .nullable(),
    failure: restoreFailure.nullable(),
    attempts: z.number().int(),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
  })
  .meta({
    id: "AdminBackupRestoreJob",
    description:
      "One restore job. `phase` and `progress` describe a running job; `result` is set once it `succeeded` (the same report the synchronous restore used to answer with, less `restored`); `failure` once it `failed`. `attempts` counts the starts: a job whose worker stopped before the data was committed is started once more; one that stopped after the commit is closed as `failed_after_commit` and never run again.",
  });

/**
 * The one refusal both routes share, worded once.
 *
 * A stored copy that will not open is bad stored input, not a fault in the
 * server: either the key that wrote it is no longer in `ENCRYPTION_KEYS`, or
 * the stored bytes are not the bytes that were written. It answers 422 like
 * every other bad input on these routes, and never as a 500.
 */
const undecryptableResponse = {
  description:
    "The stored copy could not be opened: either the key that wrote it is no longer in `ENCRYPTION_KEYS` (a rotation that dropped the legacy entry too early), or the stored bytes are not the ones that were written (a stored piece missing, moved, altered, taken from another copy, or the copy cut short), or the row holds both a single value and pieces, which only an older release writing to it after an upgrade produces. Every piece is checked before any of the copy is read. `meta.errorCode` = `backup.payload.undecryptable`. Nothing was changed.",
  content: { "application/json": { schema: errorEnvelope } },
};

/**
 * A copy replaced by a newer one (the weekly backup) while it was being
 * opened or read. Not damage: the reader starts again on the new copy.
 */
const replacedResponse = {
  description:
    "The stored copy was replaced by a newer one while it was being read. `meta.errorCode` = `backup_changed`. Nothing was changed; start again to use the new copy.",
  content: { "application/json": { schema: errorEnvelope } },
};

const adminOnlyResponse = {
  description:
    "Caller is not an admin. `requireAdmin()` is cookie-only, so a Bearer token lands here whatever its scope.",
  content: { "application/json": { schema: errorEnvelope } },
};

const notFoundResponse = {
  description: "No stored copy with this id.",
  content: { "application/json": { schema: errorEnvelope } },
};

export const adminBackupPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/admin/backups/{id}/download": {
    get: {
      tags: ["Admin"],
      summary: "Download one stored backup as JSON",
      description:
        "Decrypts one stored copy and returns the backup document itself, with `Content-Disposition: attachment` and `Cache-Control: no-store`. The response is the raw document, not the standard envelope — it is the artefact an operator keeps. The ciphertext stays in the database. Admin session cookie required; Bearer tokens cannot reach admin endpoints.",
      requestParams: {
        path: z.object({
          id: z.string().meta({ description: "`DataBackup.id`." }),
        }),
      },
      responses: {
        "200": {
          description: "The decrypted backup document.",
          content: {
            "application/json": {
              schema: z.record(z.string(), z.unknown()).meta({
                id: "AdminBackupDocument",
                description:
                  "The backup payload as the writer serialised it: `schemaVersion`, `exportedAt`, `userId`, and one array or object per serialised class.",
              }),
            },
          },
        },
        "403": adminOnlyResponse,
        "404": notFoundResponse,
        "409": replacedResponse,
        "422": undecryptableResponse,
        "500": {
          description:
            "The copy decrypted and then failed schema validation — a document this instance wrote and cannot parse. This one genuinely is a server fault, and is reported as one.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/admin/backups/{id}/restore": {
    post: {
      tags: ["Admin"],
      summary: "Queue the restore of one stored backup over its owner's record",
      description:
        "Queues a restore that replaces the snapshot owner's data tables from the stored copy, in one transaction, under the ids the file carries, and answers 202 with the job's id. Replacing is not merging: every row the account gained after the snapshot was taken is deleted with the rest of its class. The target is the account the snapshot was taken for, never the admin running it. The request refuses a missing confirmation, an unknown backup and a copy that cannot be decrypted; the file's own checks (schema, declared owner, manifest, documents) run in the job before anything is deleted, and a refusal there ends the job as `failed` with the same reason. One restore per account at a time. Admin session cookie required; Bearer tokens cannot reach admin endpoints.",
      requestParams: {
        path: z.object({
          id: z.string().meta({ description: "`DataBackup.id`." }),
        }),
      },
      // The one write here, and the destructive one: the console sends a
      // per-row key so a double-click replays the first answer instead of
      // running the transaction twice.
      parameters: [idempotencyKeyParameter],
      requestBody: {
        required: true,
        content: { "application/json": { schema: restoreRequest } },
      },
      responses: {
        "202": {
          description:
            "The restore is queued. Its progress and outcome are at `statusUrl`.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                restoreQueued,
                "AdminBackupRestoreQueuedResponse",
              ),
            },
          },
        },
        "400": {
          description: "Body was not JSON.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "403": adminOnlyResponse,
        "404": notFoundResponse,
        "409": {
          description:
            "A restore of the same account is already queued or running (`meta.errorCode` = `backup.restore.active`, `meta.jobId` names it), the stored copy was replaced by a newer one while it was being checked (`meta.errorCode` = `backup_changed`), or a request under the same `Idempotency-Key` is still in flight. Nothing was changed.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "413": {
          description: "Body exceeds 64 KiB.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "422": {
          description:
            "The request was refused before anything was queued: `confirm` missing, or the copy undecryptable (`meta.errorCode` = `backup.payload.undecryptable`).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "503": {
          description:
            "The restore could not be handed to the background worker. Nothing was changed.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/admin/backups/restores": {
    get: {
      tags: ["Admin"],
      summary: "List the restores the backups console shows",
      description:
        "Every queued or running restore, and those created in the last day, newest first, at most 20. What the console reads when it opens, so a reload during a restore picks its progress up again. Admin session cookie required; Bearer tokens cannot reach admin endpoints.",
      responses: {
        "200": {
          description: "The restore jobs.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ jobs: z.array(restoreJob) }),
                "AdminBackupRestoreJobListResponse",
              ),
            },
          },
        },
        "403": adminOnlyResponse,
      },
    },
  },
  "/api/admin/backups/restores/{jobId}": {
    get: {
      tags: ["Admin"],
      summary: "Read one restore job",
      description:
        "The status, phase and counts of one restore, and its report or its failure once it finished. Admin session cookie required; Bearer tokens cannot reach admin endpoints.",
      requestParams: {
        path: z.object({
          jobId: z.string().meta({
            description: "The `jobId` the restore request answered with.",
          }),
        }),
      },
      responses: {
        "200": {
          description: "The restore job.",
          content: {
            "application/json": {
              schema: dataEnvelope(restoreJob, "AdminBackupRestoreJobResponse"),
            },
          },
        },
        "403": adminOnlyResponse,
        "404": {
          description: "No restore job with this id.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
};
